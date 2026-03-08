"use strict";
(() => {
  // src/shared/types.ts
  var SCHEMA_VERSION = 1;
  var STORAGE_KEYS = {
    schemaVersion: "tg_schema_version",
    settings: "tg_settings",
    reminders: "tg_reminders",
    detectionsRecent: "tg_detections_recent",
    darkpatternsBase: "tg_darkpatterns_base",
    darkpatternsUser: "tg_darkpatterns_user",
    userReports: "tg_user_reports",
    notificationMap: "tg_notification_map",
    pendingDetectionByTab: "tg_pending_detection_by_tab"
  };
  var DEFAULT_SETTINGS = {
    enabled: true,
    defaultBufferDays: 2,
    disabledDomainKeys: [],
    keywordOverrides: {
      trial: [],
      renewal: [],
      subscription: [],
      commit: []
    },
    requestAllSitesOnStartup: true,
    debugOverlay: false
  };

  // src/shared/constants.ts
  var DETECTION_STORAGE_MAX = 50;
  var INTERCEPT_IDLE_MS = 5 * 60 * 1e3;
  var NOTIFICATION_MAP_TTL_MS = 24 * 60 * 60 * 1e3;
  var MODAL_BUFFER_MIN = 0;
  var MODAL_BUFFER_MAX = 7;
  var REMINDER_HOUR_LOCAL = 9;

  // src/background/storage.ts
  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key]);
      });
    });
  }
  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, () => resolve());
    });
  }
  function storageGetMany(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result));
    });
  }
  function sessionStorageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.session.get([key], (result) => {
        resolve(result[key]);
      });
    });
  }
  function sessionStorageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.session.set(values, () => resolve());
    });
  }
  function containsOrigins(origins) {
    return new Promise((resolve) => {
      chrome.permissions.contains({ origins }, (granted) => resolve(Boolean(granted)));
    });
  }
  function requestOrigins(origins) {
    return new Promise((resolve) => {
      chrome.permissions.request({ origins }, (granted) => resolve(Boolean(granted)));
    });
  }
  function normalizeSettings(input) {
    const merged = {
      ...DEFAULT_SETTINGS,
      ...input ?? {},
      keywordOverrides: {
        ...DEFAULT_SETTINGS.keywordOverrides,
        ...input?.keywordOverrides ?? {}
      }
    };
    if (!Array.isArray(merged.disabledDomainKeys)) {
      merged.disabledDomainKeys = [];
    }
    merged.defaultBufferDays = Math.max(0, Math.min(7, Number(merged.defaultBufferDays ?? DEFAULT_SETTINGS.defaultBufferDays)));
    return merged;
  }
  function normalizeReminder(input) {
    return {
      ...input,
      createdAt: input.createdAt ?? input.detectedAt,
      status: input.status ?? "active"
    };
  }
  async function runMigrations() {
    const currentVersion = Number(await storageGet(STORAGE_KEYS.schemaVersion) ?? 0);
    if (currentVersion < 1) {
      const settings = normalizeSettings(await storageGet(STORAGE_KEYS.settings));
      const reminders = (await storageGet(STORAGE_KEYS.reminders) ?? []).map(normalizeReminder);
      const detections = await storageGet(STORAGE_KEYS.detectionsRecent) ?? [];
      const userPolicies = await storageGet(STORAGE_KEYS.darkpatternsUser) ?? {};
      const reports = await storageGet(STORAGE_KEYS.userReports) ?? [];
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
  async function ensureBaseDarkpatternsLoaded() {
    const existing = await storageGet(STORAGE_KEYS.darkpatternsBase);
    if (existing && typeof existing === "object" && Object.keys(existing).length > 0) {
      return existing;
    }
    const response = await fetch(chrome.runtime.getURL("darkpatterns.json"));
    const parsed = await response.json();
    await storageSet({ [STORAGE_KEYS.darkpatternsBase]: parsed });
    return parsed;
  }
  async function getSettings() {
    const settings = await storageGet(STORAGE_KEYS.settings);
    return normalizeSettings(settings);
  }
  async function upsertSettings(partial) {
    const current = await getSettings();
    const next = normalizeSettings({
      ...current,
      ...partial,
      keywordOverrides: {
        ...current.keywordOverrides,
        ...partial.keywordOverrides ?? {}
      }
    });
    await storageSet({ [STORAGE_KEYS.settings]: next });
    return next;
  }
  async function getReminders() {
    const reminders = await storageGet(STORAGE_KEYS.reminders) ?? [];
    return reminders.map(normalizeReminder);
  }
  async function setReminders(reminders) {
    await storageSet({ [STORAGE_KEYS.reminders]: reminders.map(normalizeReminder) });
  }
  async function appendDetectionEvent(event) {
    const current = await storageGet(STORAGE_KEYS.detectionsRecent) ?? [];
    const next = [...current, event].slice(-DETECTION_STORAGE_MAX);
    await storageSet({ [STORAGE_KEYS.detectionsRecent]: next });
    return next;
  }
  async function getDetectionsRecent() {
    return await storageGet(STORAGE_KEYS.detectionsRecent) ?? [];
  }
  async function getUserPolicyOverrides() {
    return await storageGet(STORAGE_KEYS.darkpatternsUser) ?? {};
  }
  async function upsertUserPolicyOverride(domainKey, policy) {
    const current = await getUserPolicyOverrides();
    current[domainKey.toLowerCase()] = policy;
    await storageSet({ [STORAGE_KEYS.darkpatternsUser]: current });
  }
  async function getSitePolicy(domainKey) {
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
  async function appendReport(report) {
    const reports = await storageGet(STORAGE_KEYS.userReports) ?? [];
    reports.push(report);
    await storageSet({ [STORAGE_KEYS.userReports]: reports });
  }
  function findDuplicateReminder(reminders, candidate, nowMs) {
    const THIRTY_MIN_MS = 30 * 60 * 1e3;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1e3;
    for (const reminder of reminders) {
      const sameDomain = reminder.domainKey === candidate.domainKey;
      const sameKind = reminder.kind === candidate.kind;
      const sameTrialDays = (reminder.trialDays ?? null) === (candidate.trialDays ?? null);
      const closeCancelAt = Math.abs(new Date(reminder.cancelAt).getTime() - new Date(candidate.cancelAt).getTime()) <= TWENTY_FOUR_HOURS_MS;
      const recentCreation = nowMs - new Date(reminder.createdAt).getTime() <= THIRTY_MIN_MS;
      if (sameDomain && sameKind && sameTrialDays && closeCancelAt && recentCreation) {
        return reminder;
      }
    }
    return null;
  }
  async function putNotificationMapItem(notificationId, reminderId, ttlMs = NOTIFICATION_MAP_TTL_MS) {
    const map = await getNotificationMap();
    map[notificationId] = {
      notificationId,
      reminderId,
      expiresAt: Date.now() + ttlMs
    };
    await storageSet({ [STORAGE_KEYS.notificationMap]: map });
  }
  async function getNotificationMap() {
    const map = await storageGet(STORAGE_KEYS.notificationMap) ?? {};
    return map;
  }
  async function getReminderIdFromNotification(notificationId) {
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
  async function pruneNotificationMap() {
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
  async function exportLocalData() {
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
      settings: normalizeSettings(raw[STORAGE_KEYS.settings]),
      reminders: (raw[STORAGE_KEYS.reminders] ?? []).map(normalizeReminder),
      detectionsRecent: raw[STORAGE_KEYS.detectionsRecent] ?? [],
      darkpatternsUser: raw[STORAGE_KEYS.darkpatternsUser] ?? {},
      userReports: raw[STORAGE_KEYS.userReports] ?? []
    };
  }
  async function importLocalData(blob) {
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
  async function getPendingDetectionMap() {
    return await sessionStorageGet(STORAGE_KEYS.pendingDetectionByTab) ?? {};
  }
  async function setPendingDetectionMap(map) {
    await sessionStorageSet({ [STORAGE_KEYS.pendingDetectionByTab]: map });
  }
  async function pruneExpiredPendingDetections(map) {
    const now = Date.now();
    const next = {};
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
  async function setPendingDetectionForTab(tabId, detection, ttlMs = 5 * 60 * 1e3) {
    const map = await pruneExpiredPendingDetections(await getPendingDetectionMap());
    map[String(tabId)] = {
      detection,
      expiresAt: Date.now() + ttlMs
    };
    await setPendingDetectionMap(map);
  }
  async function consumePendingDetectionForTab(tabId) {
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
  async function clearPendingDetectionForTab(tabId) {
    const map = await pruneExpiredPendingDetections(await getPendingDetectionMap());
    const key = String(tabId);
    if (!map[key]) {
      return;
    }
    delete map[key];
    await setPendingDetectionMap(map);
  }

  // src/shared/utils.ts
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function uid(prefix = "tg") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function addDays(base, days) {
    const next = new Date(base);
    next.setDate(next.getDate() + days);
    return next;
  }

  // src/shared/time.ts
  function computeReminderAtLocalNine(cancelDate, options) {
    const now = options?.now ?? /* @__PURE__ */ new Date();
    const cancelAt = new Date(cancelDate);
    if (options?.devFastTrack) {
      return new Date(now.getTime() + 5 * 60 * 1e3);
    }
    const remainingMs = cancelAt.getTime() - now.getTime();
    if (remainingMs <= 0) {
      return now;
    }
    const fallbackInTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1e3);
    const fallback = fallbackInTwoHours.getTime() > cancelAt.getTime() ? now : fallbackInTwoHours;
    const target = new Date(cancelAt);
    target.setHours(REMINDER_HOUR_LOCAL, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      const nextDay = new Date(now);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(REMINDER_HOUR_LOCAL, 0, 0, 0);
      if (nextDay.getTime() > cancelAt.getTime()) {
        return fallback;
      }
      return nextDay;
    }
    if (remainingMs < 12 * 60 * 60 * 1e3 || target.getTime() > cancelAt.getTime()) {
      return fallback;
    }
    return target;
  }
  function toIcsLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${year}${month}${day}T${hours}${minutes}${seconds}`;
  }

  // src/background/reminders.ts
  var ALARM_PREFIX = "trialguard:reminder:";
  function alarmNameForReminder(reminderId) {
    return `${ALARM_PREFIX}${reminderId}`;
  }
  function reminderIdFromAlarm(alarmName) {
    if (!alarmName.startsWith(ALARM_PREFIX)) {
      return null;
    }
    return alarmName.slice(ALARM_PREFIX.length);
  }
  function createNotification(notificationId, options) {
    return new Promise((resolve) => {
      chrome.notifications.create(notificationId, options, (createdId) => resolve(createdId));
    });
  }
  function clearNotification(notificationId) {
    return new Promise((resolve) => {
      chrome.notifications.clear(notificationId, () => resolve());
    });
  }
  function createTab(url) {
    return new Promise((resolve) => {
      chrome.tabs.create({ url }, () => resolve());
    });
  }
  function coerceBufferDays(bufferDays) {
    return clamp(Number(bufferDays ?? 2), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
  }
  function computeCancelDate(now, detection, bufferDays) {
    const baselineDays = detection.trialDays ?? 30;
    return addDays(now, Math.max(0, baselineDays - bufferDays));
  }
  async function scheduleReminderAlarm(reminder) {
    const when = Math.max(Date.now() + 2e3, new Date(reminder.reminderAt).getTime());
    chrome.alarms.create(alarmNameForReminder(reminder.id), { when });
  }
  async function upsertReminderFromDetection(input) {
    const now = /* @__PURE__ */ new Date();
    const bufferDays = coerceBufferDays(input.bufferDays);
    const cancelDate = computeCancelDate(now, input.detection, bufferDays);
    const reminderAt = computeReminderAtLocalNine(cancelDate, { devFastTrack: input.devFastTrack });
    const candidateCore = {
      domainKey: input.domainKey,
      kind: input.detection.kind,
      trialDays: input.detection.trialDays,
      cancelAt: cancelDate.toISOString()
    };
    const current = await getReminders();
    const duplicate = findDuplicateReminder(current, candidateCore, now.getTime());
    if (duplicate && input.dedupeAction === "update-existing") {
      const updated = {
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
      const next2 = current.map((item) => item.id === updated.id ? updated : item);
      await setReminders(next2);
      await scheduleReminderAlarm(updated);
      return { reminder: updated, duplicateCandidateId: duplicate.id };
    }
    const reminder = {
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
  async function rehydrateReminderAlarms() {
    const reminders = await getReminders();
    for (const reminder of reminders) {
      if (reminder.status !== "active") {
        continue;
      }
      await scheduleReminderAlarm(reminder);
    }
  }
  async function findReminder(reminderId) {
    const reminders = await getReminders();
    return reminders.find((item) => item.id === reminderId) ?? null;
  }
  async function handleReminderAlarm(alarmName) {
    const reminderId = reminderIdFromAlarm(alarmName);
    if (!reminderId) {
      return;
    }
    const reminder = await findReminder(reminderId);
    if (!reminder) {
      return;
    }
    const notificationId = `trialguard:notice:${reminder.id}:${Date.now()}`;
    const options = {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Cancel your trial for ${reminder.domainKey}`,
      message: reminder.manageUrl ? "Reminder due now. Open the site or jump to your manage link." : "Reminder due now. Open the site to review and cancel if needed.",
      buttons: reminder.manageUrl ? [{ title: "Open site" }, { title: "Open manage link" }] : [{ title: "Open site" }],
      priority: 2
    };
    const createdId = await createNotification(notificationId, options);
    await putNotificationMapItem(createdId, reminder.id);
  }
  async function handleNotificationClicked(notificationId) {
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
  async function handleNotificationButtonClicked(notificationId, buttonIndex) {
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
  async function getReminderById(reminderId) {
    return findReminder(reminderId);
  }

  // src/background/ics.ts
  function toIcsUtcDateTime(date) {
    const pad = (value) => String(value).padStart(2, "0");
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());
    return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
  }
  function escapeIcsValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }
  function generateIcsForReminder(reminder) {
    const reminderAt = new Date(reminder.reminderAt);
    const endAt = new Date(reminderAt.getTime() + 30 * 60 * 1e3);
    const dtstamp = toIcsUtcDateTime(/* @__PURE__ */ new Date());
    const uid2 = `${reminder.id}@trialguard.local`;
    const summary = escapeIcsValue(`Cancel trial for ${reminder.domainKey}`);
    const descriptionLines = [
      `Domain: ${reminder.domainKey}`,
      `Cancel target date: ${new Date(reminder.cancelAt).toLocaleString()}`,
      reminder.manageUrl ? `Manage link: ${reminder.manageUrl}` : "Manage link: not available"
    ];
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TrialGuard//EN",
      "BEGIN:VEVENT",
      `UID:${escapeIcsValue(uid2)}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${toIcsLocalDateTime(reminderAt)}`,
      `DTEND:${toIcsLocalDateTime(endAt)}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${escapeIcsValue(descriptionLines.join("\\n"))}`,
      reminder.manageUrl ? `URL:${escapeIcsValue(reminder.manageUrl)}` : "",
      "END:VEVENT",
      "END:VCALENDAR"
    ].filter(Boolean);
    return `${lines.join("\r\n")}\r
`;
  }
  function downloadFile(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(chrome.runtime.lastError?.message ?? "Failed to start download"));
          return;
        }
        resolve();
      });
    });
  }
  async function exportReminderAsIcs(reminder) {
    const content = generateIcsForReminder(reminder);
    const safeDomain = reminder.domainKey.replace(/[^a-z0-9.-]/gi, "_") || "site";
    const filename = `trialguard-cancel-${safeDomain}.ics`;
    const url = `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
    await downloadFile(url, filename);
  }

  // src/shared/domain.ts
  var MULTI_PART_PUBLIC_SUFFIXES = /* @__PURE__ */ new Set([
    "ac.jp",
    "ac.nz",
    "ac.uk",
    "asn.au",
    "co.in",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.uk",
    "com.au",
    "com.br",
    "com.cn",
    "com.hk",
    "com.mx",
    "com.sg",
    "com.tr",
    "edu.au",
    "edu.cn",
    "edu.hk",
    "edu.tr",
    "gen.nz",
    "geek.nz",
    "go.jp",
    "gov.au",
    "gov.br",
    "gov.cn",
    "gov.hk",
    "gov.in",
    "gov.nz",
    "gov.uk",
    "iwi.nz",
    "lg.jp",
    "maori.nz",
    "me.uk",
    "mil.br",
    "mil.cn",
    "ne.jp",
    "net.au",
    "net.br",
    "net.cn",
    "net.in",
    "net.nz",
    "net.uk",
    "or.jp",
    "org.au",
    "org.br",
    "org.cn",
    "org.hk",
    "org.in",
    "org.nz",
    "org.uk",
    "plc.uk",
    "sch.uk",
    "school.nz"
  ]);
  var GENERIC_COUNTRY_SECOND_LEVELS = /* @__PURE__ */ new Set(["ac", "co", "com", "edu", "gov", "mil", "net", "org"]);
  function cleanHostname(hostname) {
    return hostname.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  }
  function getHostname(url) {
    try {
      return cleanHostname(new URL(url).hostname);
    } catch {
      return "";
    }
  }
  function normalizeDomainInput(input) {
    const clean = input.trim().toLowerCase();
    if (!clean) {
      return "";
    }
    try {
      const asUrl = clean.startsWith("http://") || clean.startsWith("https://") ? clean : `https://${clean}`;
      return cleanHostname(new URL(asUrl).hostname);
    } catch {
      const withoutPath = clean.split(/[/?#]/)[0];
      const withoutPort = withoutPath.replace(/:(\d+)$/, "");
      return cleanHostname(withoutPort);
    }
  }
  function isIpLike(hostname) {
    if (!hostname) {
      return false;
    }
    if (hostname === "localhost" || hostname.includes(":")) {
      return true;
    }
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  }
  function getPublicSuffixLabelCount(parts) {
    if (parts.length < 2) {
      return 1;
    }
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
      return 2;
    }
    const tld = parts[parts.length - 1];
    const secondLevel = parts[parts.length - 2];
    if (tld.length === 2 && GENERIC_COUNTRY_SECOND_LEVELS.has(secondLevel) && parts.length >= 3) {
      return 2;
    }
    return 1;
  }
  function getDomainKey(hostname) {
    const normalized = normalizeDomainInput(hostname);
    if (!normalized || isIpLike(normalized)) {
      return normalized;
    }
    const parts = normalized.split(".").filter(Boolean);
    if (parts.length <= 2) {
      return normalized;
    }
    const suffixLabelCount = getPublicSuffixLabelCount(parts);
    const registrableLabelCount = suffixLabelCount + 1;
    if (parts.length <= registrableLabelCount) {
      return normalized;
    }
    return parts.slice(-registrableLabelCount).join(".");
  }

  // src/background/background.ts
  var DYNAMIC_CONTENT_SCRIPT_ID = "trialguard-content";
  function getRegisteredContentScripts(ids) {
    return new Promise((resolve) => {
      chrome.scripting.getRegisteredContentScripts(ids ? { ids } : {}, (scripts) => resolve(scripts));
    });
  }
  function registerContentScripts(scripts) {
    return new Promise((resolve, reject) => {
      chrome.scripting.registerContentScripts(scripts, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }
  function unregisterContentScripts(ids) {
    return new Promise((resolve) => {
      chrome.scripting.unregisterContentScripts({ ids }, () => resolve());
    });
  }
  function queryTabs() {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs));
    });
  }
  function executeContentScript(tabId) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["contentScript.js"]
        },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        }
      );
    });
  }
  function openOptionsPage() {
    return new Promise((resolve) => {
      chrome.runtime.openOptionsPage(() => resolve());
    });
  }
  function hasStaticContentScriptInManifest() {
    return Boolean(chrome.runtime.getManifest().content_scripts?.length);
  }
  async function ensureContentScriptRegistration() {
    if (hasStaticContentScriptInManifest()) {
      return;
    }
    const hasAllSites = await containsOrigins(["<all_urls>"]);
    const registered = await getRegisteredContentScripts([DYNAMIC_CONTENT_SCRIPT_ID]);
    const isRegistered = registered.some((script) => script.id === DYNAMIC_CONTENT_SCRIPT_ID);
    if (hasAllSites && !isRegistered) {
      await registerContentScripts([
        {
          id: DYNAMIC_CONTENT_SCRIPT_ID,
          js: ["contentScript.js"],
          matches: ["<all_urls>"],
          runAt: "document_idle",
          persistAcrossSessions: true
        }
      ]);
      const tabs = await queryTabs();
      for (const tab of tabs) {
        if (tab.id && tab.url && /^https?:/i.test(tab.url)) {
          try {
            await executeContentScript(tab.id);
          } catch (error) {
            console.debug(`[TrialGuard] Could not inject into tab ${tab.id}`, error);
          }
        }
      }
      return;
    }
    if (!hasAllSites && isRegistered) {
      await unregisterContentScripts([DYNAMIC_CONTENT_SCRIPT_ID]);
    }
  }
  async function hasOriginPermission(origin) {
    const hasAllSites = await containsOrigins(["<all_urls>"]);
    if (hasAllSites) {
      return true;
    }
    try {
      const url = new URL(origin);
      const pattern = `${url.protocol}//${url.host}/*`;
      return await containsOrigins([pattern]);
    } catch {
      return false;
    }
  }
  async function initializeExtension() {
    await runMigrations();
    await ensureBaseDarkpatternsLoaded();
    await pruneNotificationMap();
    await ensureContentScriptRegistration();
    await rehydrateReminderAlarms();
  }
  async function buildRuntimeState(origin) {
    const [settings, hasAllSitesPermission, hostAllowedForCurrentOrigin] = await Promise.all([
      getSettings(),
      containsOrigins(["<all_urls>"]),
      hasOriginPermission(origin)
    ]);
    return {
      settings,
      hasAllSitesPermission,
      hostAllowedForCurrentOrigin
    };
  }
  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, () => resolve());
    });
  }
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "SPA_NAVIGATED": {
        return { ignored: true };
      }
      case "GET_SETTINGS": {
        return getSettings();
      }
      case "GET_RUNTIME_STATE": {
        return buildRuntimeState(message.payload.origin);
      }
      case "GET_REMINDERS": {
        return getReminders();
      }
      case "GET_DETECTIONS_RECENT": {
        return getDetectionsRecent();
      }
      case "GET_PENDING_DETECTION": {
        const tabId = sender.tab?.id;
        if (!tabId) {
          return null;
        }
        return consumePendingDetectionForTab(tabId);
      }
      case "GET_SITE_POLICY": {
        return getSitePolicy(message.payload.domainKey);
      }
      case "UPSERT_SETTINGS": {
        return upsertSettings(message.payload);
      }
      case "UPSERT_REMINDER": {
        const devFastTrack = chrome.runtime.getManifest().name.includes("(Dev)");
        return upsertReminderFromDetection({
          ...message.payload,
          devFastTrack
        });
      }
      case "UPSERT_SITE_POLICY_OVERRIDE": {
        await upsertUserPolicyOverride(message.payload.domainKey, message.payload.policy);
        return { success: true };
      }
      case "UPSERT_REPORT": {
        const report = {
          id: uid("report"),
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          ...message.payload.report
        };
        await appendReport(report);
        return { success: true };
      }
      case "UPSERT_DETECTION_EVENT": {
        return appendDetectionEvent(message.payload.event);
      }
      case "SET_PENDING_DETECTION": {
        const tabId = sender.tab?.id;
        if (!tabId) {
          throw new Error("SET_PENDING_DETECTION requires sender tab context");
        }
        await setPendingDetectionForTab(tabId, message.payload.detection);
        return { success: true };
      }
      case "REQUEST_HOST_PERMISSIONS": {
        const granted = await requestOrigins(["<all_urls>"]);
        await ensureContentScriptRegistration();
        return { granted };
      }
      case "EXPORT_ICS": {
        const reminder = await getReminderById(message.payload.reminderId);
        if (!reminder) {
          throw new Error("Reminder not found");
        }
        await exportReminderAsIcs(reminder);
        return { success: true };
      }
      case "EXPORT_LOCAL_DATA": {
        return exportLocalData();
      }
      case "IMPORT_LOCAL_DATA": {
        await importLocalData(message.payload.data);
        await ensureContentScriptRegistration();
        await rehydrateReminderAlarms();
        return { success: true };
      }
      default: {
        const exhaustiveCheck = message;
        throw new Error(`Unsupported message: ${exhaustiveCheck.type}`);
      }
    }
  }
  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      await initializeExtension();
      if (details.reason === "install" || details.reason === "update") {
        const settings = await getSettings();
        if (settings.requestAllSitesOnStartup) {
          await openOptionsPage();
        }
      }
    })();
  });
  chrome.runtime.onStartup.addListener(() => {
    void initializeExtension();
  });
  chrome.permissions.onAdded.addListener(() => {
    void ensureContentScriptRegistration();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void ensureContentScriptRegistration();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleReminderAlarm(alarm.name);
  });
  chrome.notifications.onClicked.addListener((notificationId) => {
    void handleNotificationClicked(notificationId);
  });
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    void handleNotificationButtonClicked(notificationId, buttonIndex);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) {
      return;
    }
    void sendTabMessage(tabId, {
      type: "SPA_NAVIGATED",
      payload: { url: changeInfo.url }
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearPendingDetectionForTab(tabId);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender).then((data) => {
      const response = { ok: true, data };
      sendResponse(response);
    }).catch((error) => {
      const response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      sendResponse(response);
    });
    return true;
  });
  function deriveDomainKeyFromUrl(url) {
    const hostname = getHostname(url);
    const domainKey = getDomainKey(hostname);
    return { hostname, domainKey };
  }
})();
//# sourceMappingURL=background.js.map
