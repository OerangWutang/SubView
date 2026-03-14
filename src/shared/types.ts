export const SCHEMA_VERSION = 2;

export const STORAGE_KEYS = {
  schemaVersion: "tg_schema_version",
  settings: "tg_settings",
  reminders: "tg_reminders",
  detectionsRecent: "tg_detections_recent",
  darkpatternsBase: "tg_darkpatterns_base",
  darkpatternsUser: "tg_darkpatterns_user",
  userReports: "tg_user_reports",
  notificationMap: "tg_notification_map",
  pendingDetectionByTab: "tg_pending_detection_by_tab"
} as const;

export type BillingCycle = "weekly" | "monthly" | "yearly" | "custom";

export type DetectionKind = "trial" | "subscription" | "unknown";

export type DetectionResult = {
  confidence: number;
  kind: DetectionKind;
  trialDays?: number;
  priceAfterTrial?: string;
  renewalPeriod?: "week" | "month" | "year" | string;
  evidence: string[];
  detectedAtUrl: string;
};

export type ReminderStatus = "active" | "completed" | "dismissed";

export type ReminderRecord = {
  id: string;
  hostname: string;
  domainKey: string;
  createdAt: string;
  kind: DetectionKind;
  trialDays?: number;
  detectedAt: string;
  cancelAt: string;
  reminderAt: string;
  bufferDays: number;
  manageUrl?: string;
  status: ReminderStatus;
  duplicateOf?: string;
  pricePerCycle?: number;
  billingCycle?: BillingCycle;
  renewalDate?: string;
  tosRequiredDays?: number;
  tosDeadlineAt?: string;
};

export type Difficulty = "easy" | "medium" | "hard";
export type CancelMethod = "in-app" | "email" | "phone" | "unknown";

export type SitePolicy = {
  difficulty: Difficulty;
  method: CancelMethod;
  notes?: string;
  steps?: string[];
  manageUrl?: string;
  tosRequiredDays?: number;
};

export type DetectionEvent = {
  id: string;
  hostname: string;
  domainKey: string;
  confidence: number;
  kind: DetectionKind;
  detectedAtUrl: string;
  ts: string;
};

export type KeywordOverrides = {
  trial: string[];
  renewal: string[];
  subscription: string[];
  commit: string[];
};

export type UserSettings = {
  enabled: boolean;
  defaultBufferDays: number;
  disabledDomainKeys: string[];
  keywordOverrides: KeywordOverrides;
  requestAllSitesOnStartup: boolean;
  debugOverlay: boolean;
};

export type UserReport = {
  id: string;
  domainKey: string;
  hostname: string;
  difficulty: Difficulty;
  notes?: string;
  ts: string;
};

export type NotificationMapItem = {
  notificationId: string;
  reminderId: string;
  expiresAt: number;
};

export type PendingDetectionItem = {
  detection: DetectionResult;
  expiresAt: number;
};

export type DarkPatternsMap = Record<string, SitePolicy>;

export type RuntimeState = {
  hasAllSitesPermission: boolean;
  settings: UserSettings;
  hostAllowedForCurrentOrigin: boolean;
};

export type ImportExportBlob = {
  schemaVersion: number;
  settings?: UserSettings;
  reminders?: ReminderRecord[];
  detectionsRecent?: DetectionEvent[];
  darkpatternsUser?: DarkPatternsMap;
  userReports?: UserReport[];
};

export type Message =
  | { type: "SPA_NAVIGATED"; payload: { url: string } }
  | { type: "GET_SETTINGS" }
  | { type: "GET_RUNTIME_STATE"; payload: { origin: string } }
  | { type: "GET_REMINDERS" }
  | { type: "GET_DETECTIONS_RECENT" }
  | { type: "GET_PENDING_DETECTION" }
  | { type: "GET_SITE_POLICY"; payload: { domainKey: string } }
  | { type: "UPSERT_SETTINGS"; payload: Partial<UserSettings> }
  | {
      type: "UPSERT_REMINDER";
      payload: {
        detection: DetectionResult;
        hostname: string;
        domainKey: string;
        bufferDays: number;
        manageUrl?: string;
        dedupeAction?: "keep-both" | "update-existing";
        pricePerCycle?: number;
        billingCycle?: BillingCycle;
        renewalDate?: string;
        tosRequiredDays?: number;
      };
    }
  | { type: "UPSERT_SITE_POLICY_OVERRIDE"; payload: { domainKey: string; policy: SitePolicy } }
  | { type: "UPSERT_REPORT"; payload: { report: Omit<UserReport, "id" | "ts"> } }
  | { type: "UPSERT_DETECTION_EVENT"; payload: { event: DetectionEvent } }
  | { type: "SET_PENDING_DETECTION"; payload: { detection: DetectionResult } }
  | { type: "REQUEST_HOST_PERMISSIONS" }
  | { type: "EXPORT_ICS"; payload: { reminderId: string } }
  | { type: "EXPORT_LOCAL_DATA" }
  | { type: "IMPORT_LOCAL_DATA"; payload: { data: ImportExportBlob } };

export type MessageResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export const DEFAULT_SETTINGS: UserSettings = {
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
