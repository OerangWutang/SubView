import type { DetectionResult, ReminderRecord } from "../shared/types";
import { MODAL_BUFFER_MAX, MODAL_BUFFER_MIN } from "../shared/constants";
import { addDays, clamp, uid } from "../shared/utils";
import { computeReminderAtLocalNine } from "../shared/time";
import {
  findDuplicateReminder,
  getReminderIdFromNotification,
  getReminders,
  putNotificationMapItem,
  setReminders
} from "./storage";

const ALARM_PREFIX = "trialguard:reminder:";

export function alarmNameForReminder(reminderId: string): string {
  return `${ALARM_PREFIX}${reminderId}`;
}

function reminderIdFromAlarm(alarmName: string): string | null {
  if (!alarmName.startsWith(ALARM_PREFIX)) {
    return null;
  }
  return alarmName.slice(ALARM_PREFIX.length);
}

function createNotification(
  notificationId: string,
  options: chrome.notifications.NotificationCreateOptions
): Promise<string> {
  return new Promise((resolve) => {
    chrome.notifications.create(notificationId, options, (createdId) => resolve(createdId));
  });
}

function clearNotification(notificationId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.notifications.clear(notificationId, () => resolve());
  });
}

function createTab(url: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.create({ url }, () => resolve());
  });
}

function coerceBufferDays(bufferDays: number): number {
  return clamp(Number(bufferDays ?? 2), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
}

function computeCancelDate(now: Date, detection: DetectionResult, bufferDays: number): Date {
  const baselineDays = detection.trialDays ?? 30;
  return addDays(now, Math.max(0, baselineDays - bufferDays));
}

export async function scheduleReminderAlarm(reminder: ReminderRecord): Promise<void> {
  const when = Math.max(Date.now() + 2_000, new Date(reminder.reminderAt).getTime());
  chrome.alarms.create(alarmNameForReminder(reminder.id), { when });
}

export async function upsertReminderFromDetection(input: {
  detection: DetectionResult;
  hostname: string;
  domainKey: string;
  bufferDays: number;
  manageUrl?: string;
  dedupeAction?: "keep-both" | "update-existing";
  devFastTrack?: boolean;
}): Promise<{ reminder: ReminderRecord; duplicateCandidateId?: string }> {
  const now = new Date();
  const bufferDays = coerceBufferDays(input.bufferDays);
  const cancelDate = computeCancelDate(now, input.detection, bufferDays);
  const reminderAt = computeReminderAtLocalNine(cancelDate, { devFastTrack: input.devFastTrack });

  const candidateCore = {
    domainKey: input.domainKey,
    kind: input.detection.kind,
    trialDays: input.detection.trialDays,
    cancelAt: cancelDate.toISOString()
  } as const;

  const current = await getReminders();
  const duplicate = findDuplicateReminder(current, candidateCore, now.getTime());

  if (duplicate && input.dedupeAction === "update-existing") {
    const updated: ReminderRecord = {
      ...duplicate,
      hostname: input.hostname,
      trialDays: input.detection.trialDays,
      kind: input.detection.kind,
      detectedAt: now.toISOString(),
      cancelAt: cancelDate.toISOString(),
      reminderAt: reminderAt.toISOString(),
      bufferDays,
      manageUrl: input.manageUrl ?? duplicate.manageUrl,
      status: "active"
    };

    const next = current.map((item) => (item.id === updated.id ? updated : item));
    await setReminders(next);
    await scheduleReminderAlarm(updated);
    return { reminder: updated, duplicateCandidateId: duplicate.id };
  }

  const reminder: ReminderRecord = {
    id: uid("rem"),
    createdAt: now.toISOString(),
    hostname: input.hostname,
    domainKey: input.domainKey,
    kind: input.detection.kind,
    trialDays: input.detection.trialDays,
    detectedAt: now.toISOString(),
    cancelAt: cancelDate.toISOString(),
    reminderAt: reminderAt.toISOString(),
    bufferDays,
    manageUrl: input.manageUrl,
    status: "active",
    duplicateOf: duplicate?.id
  };

  const next = [...current, reminder];
  await setReminders(next);
  await scheduleReminderAlarm(reminder);
  return { reminder, duplicateCandidateId: duplicate?.id };
}

export async function rehydrateReminderAlarms(): Promise<void> {
  const reminders = await getReminders();
  for (const reminder of reminders) {
    if (reminder.status !== "active") {
      continue;
    }
    await scheduleReminderAlarm(reminder);
  }
}

async function findReminder(reminderId: string): Promise<ReminderRecord | null> {
  const reminders = await getReminders();
  return reminders.find((item) => item.id === reminderId) ?? null;
}

export async function handleReminderAlarm(alarmName: string): Promise<void> {
  const reminderId = reminderIdFromAlarm(alarmName);
  if (!reminderId) {
    return;
  }

  const reminder = await findReminder(reminderId);
  if (!reminder) {
    return;
  }

  const notificationId = `trialguard:notice:${reminder.id}:${Date.now()}`;
  const options: chrome.notifications.NotificationCreateOptions = {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `Cancel your trial for ${reminder.domainKey}`,
    message: reminder.manageUrl
      ? "Reminder due now. Open the site or jump to your manage link."
      : "Reminder due now. Open the site to review and cancel if needed.",
    buttons: reminder.manageUrl
      ? [{ title: "Open site" }, { title: "Open manage link" }]
      : [{ title: "Open site" }],
    priority: 2
  };

  const createdId = await createNotification(notificationId, options);
  await putNotificationMapItem(createdId, reminder.id);
}

export async function handleNotificationClicked(notificationId: string): Promise<void> {
  const reminderId = await getReminderIdFromNotification(notificationId);
  if (!reminderId) {
    return;
  }

  const reminder = await findReminder(reminderId);
  if (!reminder) {
    return;
  }

  await createTab(`https://${reminder.hostname}`);
  await clearNotification(notificationId);
}

export async function handleNotificationButtonClicked(notificationId: string, buttonIndex: number): Promise<void> {
  const reminderId = await getReminderIdFromNotification(notificationId);
  if (!reminderId) {
    return;
  }

  const reminder = await findReminder(reminderId);
  if (!reminder) {
    return;
  }

  if (buttonIndex === 1 && reminder.manageUrl) {
    await createTab(reminder.manageUrl);
  } else {
    await createTab(`https://${reminder.hostname}`);
  }

  await clearNotification(notificationId);
}

export async function getReminderById(reminderId: string): Promise<ReminderRecord | null> {
  return findReminder(reminderId);
}
