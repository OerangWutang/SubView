import type { BillingCycle, DetectionResult, ReminderRecord } from "../shared/types";
import { MODAL_BUFFER_MAX, MODAL_BUFFER_MIN } from "../shared/constants";
import { addDays, clamp, daysUntilDate, uid } from "../shared/utils";
import { computeReminderAtLocalNine } from "../shared/time";
import {
  findDuplicateReminder,
  getReminderIdFromNotification,
  getReminders,
  putNotificationMapItem,
  setReminders
} from "./storage";

const ALARM_PREFIX = "subview:reminder:";
const TOS_ALARM_PREFIX = "subview:tos-warning:";

export function alarmNameForReminder(reminderId: string): string {
  return `${ALARM_PREFIX}${reminderId}`;
}

export function tosAlarmNameForReminder(reminderId: string): string {
  return `${TOS_ALARM_PREFIX}${reminderId}`;
}

function reminderIdFromAlarm(alarmName: string): string | null {
  if (alarmName.startsWith(TOS_ALARM_PREFIX)) {
    return alarmName.slice(TOS_ALARM_PREFIX.length);
  }
  if (alarmName.startsWith(ALARM_PREFIX)) {
    return alarmName.slice(ALARM_PREFIX.length);
  }
  return null;
}

function isTosAlarm(alarmName: string): boolean {
  return alarmName.startsWith(TOS_ALARM_PREFIX);
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

function computeCancelDate(now: Date, detection: DetectionResult, bufferDays: number, renewalDate?: string): Date {
  if (renewalDate) {
    const renewal = new Date(renewalDate);
    if (!isNaN(renewal.getTime())) {
      return addDays(renewal, -bufferDays);
    }
  }
  const baselineDays = detection.trialDays ?? 30;
  return addDays(now, Math.max(0, baselineDays - bufferDays));
}

function computeTosDeadline(renewalDate: string, tosRequiredDays: number): Date {
  return addDays(new Date(renewalDate), -tosRequiredDays);
}

export { computeMonthlyEquivalentCost, daysUntilDate } from "../shared/utils";

export async function scheduleReminderAlarm(reminder: ReminderRecord): Promise<void> {
  const when = Math.max(Date.now() + 2_000, new Date(reminder.reminderAt).getTime());
  chrome.alarms.create(alarmNameForReminder(reminder.id), { when });

  if (reminder.tosDeadlineAt) {
    const tosAlarmAt = computeReminderAtLocalNine(new Date(reminder.tosDeadlineAt));
    const tosWhen = Math.max(Date.now() + 2_000, tosAlarmAt.getTime());
    chrome.alarms.create(tosAlarmNameForReminder(reminder.id), { when: tosWhen });
  }
}

export async function upsertReminderFromDetection(input: {
  detection: DetectionResult;
  hostname: string;
  domainKey: string;
  bufferDays: number;
  manageUrl?: string;
  dedupeAction?: "keep-both" | "update-existing";
  devFastTrack?: boolean;
  pricePerCycle?: number;
  billingCycle?: BillingCycle;
  renewalDate?: string;
  tosRequiredDays?: number;
}): Promise<{ reminder: ReminderRecord; duplicateCandidateId?: string }> {
  const now = new Date();
  const bufferDays = coerceBufferDays(input.bufferDays);
  const cancelDate = computeCancelDate(now, input.detection, bufferDays, input.renewalDate);
  const reminderAt = computeReminderAtLocalNine(cancelDate, { devFastTrack: input.devFastTrack });

  const tosDeadlineAt =
    input.renewalDate && input.tosRequiredDays && input.tosRequiredDays > 0
      ? computeTosDeadline(input.renewalDate, input.tosRequiredDays).toISOString()
      : undefined;

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
      status: "active",
      pricePerCycle: input.pricePerCycle ?? duplicate.pricePerCycle,
      billingCycle: input.billingCycle ?? duplicate.billingCycle,
      renewalDate: input.renewalDate ?? duplicate.renewalDate,
      tosRequiredDays: input.tosRequiredDays ?? duplicate.tosRequiredDays,
      tosDeadlineAt: tosDeadlineAt ?? duplicate.tosDeadlineAt
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
    duplicateOf: duplicate?.id,
    pricePerCycle: input.pricePerCycle,
    billingCycle: input.billingCycle,
    renewalDate: input.renewalDate,
    tosRequiredDays: input.tosRequiredDays,
    tosDeadlineAt
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

  const isTos = isTosAlarm(alarmName);
  const notificationId = `subview:notice:${reminder.id}:${Date.now()}`;

  let title: string;
  let message: string;

  if (isTos && reminder.tosDeadlineAt) {
    title = `⚠️ ToS Cancellation Deadline for ${reminder.domainKey}`;
    message = reminder.tosRequiredDays
      ? `Terms of Service require cancellation at least ${reminder.tosRequiredDays} day(s) before renewal. Cancel today to avoid being charged.`
      : `Today is your last safe cancellation day per Terms of Service. Cancel now to avoid being charged.`;
  } else {
    const daysUntilRenewal = reminder.renewalDate ? daysUntilDate(reminder.renewalDate) : null;
    const renewalInfo = daysUntilRenewal !== null ? ` Renewal in ${daysUntilRenewal} day(s).` : "";
    const costInfo = reminder.pricePerCycle != null && reminder.billingCycle
      ? ` Cost: $${reminder.pricePerCycle.toFixed(2)}/${reminder.billingCycle}.`
      : "";
    title = `Cancel your ${reminder.kind} for ${reminder.domainKey}`;
    message = reminder.manageUrl
      ? `Reminder due now.${renewalInfo}${costInfo} Open the site or jump to your manage link.`
      : `Reminder due now.${renewalInfo}${costInfo} Open the site to review and cancel if needed.`;
  }

  const options: chrome.notifications.NotificationCreateOptions = {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    buttons: reminder.manageUrl
      ? [{ title: "Open site" }, { title: "Open manage link" }]
      : [{ title: "Open site" }],
    priority: 2
  };

  const createdId = await createNotification(notificationId, options);
  await putNotificationMapItem(createdId, reminder.id);
}

async function completeReminder(reminderId: string): Promise<void> {
  const reminders = await getReminders();
  const next = reminders.map((item) =>
    item.id === reminderId ? { ...item, status: "completed" as const } : item
  );
  await setReminders(next);
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
  await completeReminder(reminder.id);
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
  await completeReminder(reminder.id);
}

export async function getReminderById(reminderId: string): Promise<ReminderRecord | null> {
  return findReminder(reminderId);
}

