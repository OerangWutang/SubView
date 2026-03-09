import {
  DEFAULT_SETTINGS,
  type DarkPatternsMap,
  type DetectionResult,
  type DetectionEvent,
  type ImportExportBlob,
  type NotificationMapItem,
  type PendingDetectionItem,
  type ReminderRecord,
  SCHEMA_VERSION,
  type SitePolicy,
  STORAGE_KEYS,
  type UserReport,
  type UserSettings
} from "../shared/types";
import { DETECTION_STORAGE_MAX, NOTIFICATION_MAP_TTL_MS } from "../shared/constants";

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageGetMany(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function sessionStorageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.session.get([key], (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function sessionStorageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.set(values, () => resolve());
  });
}

export function containsOrigins(origins: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins }, (granted) => resolve(Boolean(granted)));
  });
}

export function requestOrigins(origins: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => resolve(Boolean(granted)));
  });
}

function normalizeSettings(input: Partial<UserSettings> | undefined): UserSettings {
  const merged: UserSettings = {
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
    keywordOverrides: {
      ...DEFAULT_SETTINGS.keywordOverrides,
      ...(input?.keywordOverrides ?? {})
    }
  };

  if (!Array.isArray(merged.disabledDomainKeys)) {
    merged.disabledDomainKeys = [];
  }

  merged.defaultBufferDays = Math.max(0, Math.min(7, Number(merged.defaultBufferDays ?? DEFAULT_SETTINGS.defaultBufferDays)));

  return merged;
}

function normalizeReminder(input: ReminderRecord): ReminderRecord {
  return {
    ...input,
    createdAt: input.createdAt ?? input.detectedAt,
    status: input.status ?? "active"
  };
}

export async function runMigrations(): Promise<void> {
  const currentVersion = Number((await storageGet<number>(STORAGE_KEYS.schemaVersion)) ?? 0);

  if (currentVersion < 1) {
    const settings = normalizeSettings(await storageGet<UserSettings>(STORAGE_KEYS.settings));
    const reminders = ((await storageGet<ReminderRecord[]>(STORAGE_KEYS.reminders)) ?? []).map(normalizeReminder);
    const detections = (await storageGet<DetectionEvent[]>(STORAGE_KEYS.detectionsRecent)) ?? [];
    const userPolicies = (await storageGet<DarkPatternsMap>(STORAGE_KEYS.darkpatternsUser)) ?? {};
    const reports = (await storageGet<UserReport[]>(STORAGE_KEYS.userReports)) ?? [];

    await storageSet({
      [STORAGE_KEYS.schemaVersion]: SCHEMA_VERSION,
      [STORAGE_KEYS.settings]: settings,
      [STORAGE_KEYS.reminders]: reminders,
      [STORAGE_KEYS.detectionsRecent]: detections.slice(-DETECTION_STORAGE_MAX),
      [STORAGE_KEYS.darkpatternsUser]: userPolicies,
      [STORAGE_KEYS.userReports]: reports
    });
  }
}

export async function ensureBaseDarkpatternsLoaded(): Promise<DarkPatternsMap> {
  const existing = await storageGet<DarkPatternsMap>(STORAGE_KEYS.darkpatternsBase);
  if (existing && typeof existing === "object" && Object.keys(existing).length > 0) {
    return existing;
  }

  const response = await fetch(chrome.runtime.getURL("darkpatterns.json"));
  const parsed = (await response.json()) as DarkPatternsMap;
  await storageSet({ [STORAGE_KEYS.darkpatternsBase]: parsed });
  return parsed;
}

export async function getSettings(): Promise<UserSettings> {
  const settings = await storageGet<UserSettings>(STORAGE_KEYS.settings);
  return normalizeSettings(settings);
}

export async function upsertSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings();
  const next = normalizeSettings({
    ...current,
    ...partial,
    keywordOverrides: {
      ...current.keywordOverrides,
      ...(partial.keywordOverrides ?? {})
    }
  });
  await storageSet({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getReminders(): Promise<ReminderRecord[]> {
  const reminders = (await storageGet<ReminderRecord[]>(STORAGE_KEYS.reminders)) ?? [];
  return reminders.map(normalizeReminder);
}

export async function setReminders(reminders: ReminderRecord[]): Promise<void> {
  await storageSet({ [STORAGE_KEYS.reminders]: reminders.map(normalizeReminder) });
}

export async function appendDetectionEvent(event: DetectionEvent): Promise<DetectionEvent[]> {
  const current = (await storageGet<DetectionEvent[]>(STORAGE_KEYS.detectionsRecent)) ?? [];
  const next = [...current, event].slice(-DETECTION_STORAGE_MAX);
  await storageSet({ [STORAGE_KEYS.detectionsRecent]: next });
  return next;
}

export async function getDetectionsRecent(): Promise<DetectionEvent[]> {
  return (await storageGet<DetectionEvent[]>(STORAGE_KEYS.detectionsRecent)) ?? [];
}

export async function getUserPolicyOverrides(): Promise<DarkPatternsMap> {
  return (await storageGet<DarkPatternsMap>(STORAGE_KEYS.darkpatternsUser)) ?? {};
}

export async function upsertUserPolicyOverride(domainKey: string, policy: SitePolicy): Promise<void> {
  const current = await getUserPolicyOverrides();
  current[domainKey.toLowerCase()] = policy;
  await storageSet({ [STORAGE_KEYS.darkpatternsUser]: current });
}

export async function getSitePolicy(domainKey: string): Promise<SitePolicy | null> {
  const key = domainKey.toLowerCase();
  const [base, user] = await Promise.all([ensureBaseDarkpatternsLoaded(), getUserPolicyOverrides()]);
  if (user[key]) {
    return user[key];
  }
  if (base[key]) {
    return base[key];
  }
  return null;
}

export async function appendReport(report: UserReport): Promise<void> {
  const reports = (await storageGet<UserReport[]>(STORAGE_KEYS.userReports)) ?? [];
  reports.push(report);
  await storageSet({ [STORAGE_KEYS.userReports]: reports });
}

export async function getReports(): Promise<UserReport[]> {
  return (await storageGet<UserReport[]>(STORAGE_KEYS.userReports)) ?? [];
}

export function findDuplicateReminder(
  reminders: ReminderRecord[],
  candidate: Pick<ReminderRecord, "domainKey" | "kind" | "trialDays" | "cancelAt">,
  nowMs: number
): ReminderRecord | null {
  const THIRTY_MIN_MS = 30 * 60 * 1000;

  // Normalize cancelAt to UTC date bucket (YYYY-MM-DD) for a stable comparison
  // that is unaffected by sub-day clock drift between detections.
  const candidateCancelDay = candidate.cancelAt.slice(0, 10);

  for (const reminder of reminders) {
    const sameDomain = reminder.domainKey === candidate.domainKey;
    const sameKind = reminder.kind === candidate.kind;
    const sameTrialDays = (reminder.trialDays ?? null) === (candidate.trialDays ?? null);
    const sameCancelDay = reminder.cancelAt.slice(0, 10) === candidateCancelDay;
    const recentCreation = nowMs - new Date(reminder.createdAt).getTime() <= THIRTY_MIN_MS;

    if (sameDomain && sameKind && sameTrialDays && sameCancelDay && recentCreation) {
      return reminder;
    }
  }

  return null;
}

export async function putNotificationMapItem(
  notificationId: string,
  reminderId: string,
  ttlMs = NOTIFICATION_MAP_TTL_MS
): Promise<void> {
  const map = await getNotificationMap();
  map[notificationId] = {
    notificationId,
    reminderId,
    expiresAt: Date.now() + ttlMs
  };
  await storageSet({ [STORAGE_KEYS.notificationMap]: map });
}

export async function getNotificationMap(): Promise<Record<string, NotificationMapItem>> {
  const map = (await storageGet<Record<string, NotificationMapItem>>(STORAGE_KEYS.notificationMap)) ?? {};
  return map;
}

export async function getReminderIdFromNotification(notificationId: string): Promise<string | null> {
  const map = await getNotificationMap();
  const item = map[notificationId];
  if (!item) {
    return null;
  }

  if (item.expiresAt <= Date.now()) {
    delete map[notificationId];
    await storageSet({ [STORAGE_KEYS.notificationMap]: map });
    return null;
  }

  return item.reminderId;
}

export async function pruneNotificationMap(): Promise<void> {
  const map = await getNotificationMap();
  const now = Date.now();
  let dirty = false;

  for (const [notificationId, value] of Object.entries(map)) {
    if (value.expiresAt <= now) {
      delete map[notificationId];
      dirty = true;
    }
  }

  if (dirty) {
    await storageSet({ [STORAGE_KEYS.notificationMap]: map });
  }
}

export async function exportLocalData(): Promise<ImportExportBlob> {
  const raw = await storageGetMany([
    STORAGE_KEYS.schemaVersion,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.reminders,
    STORAGE_KEYS.detectionsRecent,
    STORAGE_KEYS.darkpatternsUser,
    STORAGE_KEYS.userReports
  ]);

  return {
    schemaVersion: Number((raw[STORAGE_KEYS.schemaVersion] ?? SCHEMA_VERSION) || SCHEMA_VERSION),
    settings: normalizeSettings(raw[STORAGE_KEYS.settings] as UserSettings | undefined),
    reminders: ((raw[STORAGE_KEYS.reminders] as ReminderRecord[] | undefined) ?? []).map(normalizeReminder),
    detectionsRecent: (raw[STORAGE_KEYS.detectionsRecent] as DetectionEvent[] | undefined) ?? [],
    darkpatternsUser: (raw[STORAGE_KEYS.darkpatternsUser] as DarkPatternsMap | undefined) ?? {},
    userReports: (raw[STORAGE_KEYS.userReports] as UserReport[] | undefined) ?? []
  };
}

export async function importLocalData(blob: ImportExportBlob): Promise<void> {
  if (!blob || typeof blob !== "object") {
    throw new Error("Invalid import payload");
  }

  await storageSet({
    [STORAGE_KEYS.settings]: normalizeSettings(blob.settings),
    [STORAGE_KEYS.reminders]: (blob.reminders ?? []).map(normalizeReminder),
    [STORAGE_KEYS.detectionsRecent]: (blob.detectionsRecent ?? []).slice(-DETECTION_STORAGE_MAX),
    [STORAGE_KEYS.darkpatternsUser]: blob.darkpatternsUser ?? {},
    [STORAGE_KEYS.userReports]: blob.userReports ?? [],
    [STORAGE_KEYS.schemaVersion]: SCHEMA_VERSION
  });

  await runMigrations();
}

type PendingDetectionMap = Record<string, PendingDetectionItem>;

async function getPendingDetectionMap(): Promise<PendingDetectionMap> {
  return (await sessionStorageGet<PendingDetectionMap>(STORAGE_KEYS.pendingDetectionByTab)) ?? {};
}

async function setPendingDetectionMap(map: PendingDetectionMap): Promise<void> {
  await sessionStorageSet({ [STORAGE_KEYS.pendingDetectionByTab]: map });
}

async function pruneExpiredPendingDetections(map: PendingDetectionMap): Promise<PendingDetectionMap> {
  const now = Date.now();
  const next: PendingDetectionMap = {};

  for (const [tabId, value] of Object.entries(map)) {
    if (value.expiresAt > now) {
      next[tabId] = value;
    }
  }

  if (Object.keys(next).length !== Object.keys(map).length) {
    await setPendingDetectionMap(next);
  }

  return next;
}

export async function setPendingDetectionForTab(
  tabId: number,
  detection: DetectionResult,
  ttlMs = 5 * 60 * 1000
): Promise<void> {
  const map = await pruneExpiredPendingDetections(await getPendingDetectionMap());
  map[String(tabId)] = {
    detection,
    expiresAt: Date.now() + ttlMs
  };
  await setPendingDetectionMap(map);
}

export async function consumePendingDetectionForTab(tabId: number): Promise<DetectionResult | null> {
  const map = await pruneExpiredPendingDetections(await getPendingDetectionMap());
  const key = String(tabId);
  const item = map[key];

  if (!item) {
    return null;
  }

  delete map[key];
  await setPendingDetectionMap(map);
  return item.detection;
}

export async function clearPendingDetectionForTab(tabId: number): Promise<void> {
  const map = await pruneExpiredPendingDetections(await getPendingDetectionMap());
  const key = String(tabId);
  if (!map[key]) {
    return;
  }

  delete map[key];
  await setPendingDetectionMap(map);
}
