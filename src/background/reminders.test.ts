import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReminderAlarm, upsertReminderFromDetection } from "./reminders";
import type { DetectionResult, ReminderRecord } from "../shared/types";

vi.mock("./storage", () => ({
  getReminders: vi.fn(),
  putNotificationMapItem: vi.fn().mockResolvedValue(undefined),
  getReminderIdFromNotification: vi.fn(),
  findDuplicateReminder: vi.fn(),
  setReminders: vi.fn()
}));

const { getReminders, findDuplicateReminder, setReminders } = await import("./storage");

const mockNotificationsCreate = vi.fn((_id: string, _opts: unknown, cb?: (id: string) => void) => {
  if (cb) cb(_id);
});

const mockAlarmsCreate = vi.fn();

vi.stubGlobal("chrome", {
  notifications: {
    create: mockNotificationsCreate
  },
  alarms: {
    create: mockAlarmsCreate
  }
});

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem-001",
    createdAt: "2025-01-01T00:00:00.000Z",
    hostname: "example.com",
    domainKey: "example.com",
    kind: "trial",
    trialDays: 14,
    detectedAt: "2025-01-01T00:00:00.000Z",
    cancelAt: "2025-01-15T09:00:00.000Z",
    reminderAt: "2025-01-14T09:00:00.000Z",
    bufferDays: 2,
    status: "active",
    ...overrides
  };
}

function makeDetection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    kind: "trial",
    trialDays: 14,
    confidence: 0.9,
    evidence: [],
    detectedAtUrl: "https://example.com/checkout",
    ...overrides
  };
}

describe("handleReminderAlarm - delayed alarm urgency", () => {
  beforeEach(() => {
    mockNotificationsCreate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses standard message when alarm fires on time", async () => {
    vi.mocked(getReminders).mockResolvedValue([makeReminder()]);

    const now = Date.now();
    const scheduledTime = now - 1_000; // 1 second ago (on time)

    await handleReminderAlarm("subview:reminder:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.title).toBe("Cancel your trial for example.com");
    expect(opts.message).toContain("Reminder due now.");
    expect(opts.message).not.toContain("while you were away");
  });

  it("uses urgency message when alarm is more than 24 hours late", async () => {
    vi.mocked(getReminders).mockResolvedValue([makeReminder()]);

    const now = Date.now();
    const scheduledTime = now - 25 * 60 * 60 * 1000; // 25 hours ago

    await handleReminderAlarm("subview:reminder:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.title).toContain("Overdue");
    expect(opts.message).toBe("Your trial for example.com might have ended while you were away!");
  });

  it("uses urgency message for TOS alarm more than 24 hours late", async () => {
    vi.mocked(getReminders).mockResolvedValue([
      makeReminder({
        tosDeadlineAt: "2025-01-12T00:00:00.000Z",
        tosRequiredDays: 3
      })
    ]);

    const now = Date.now();
    const scheduledTime = now - 25 * 60 * 60 * 1000; // 25 hours ago

    await handleReminderAlarm("subview:tos-warning:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.message).toContain("while you were away");
  });

  it("uses standard TOS message when alarm fires on time", async () => {
    vi.mocked(getReminders).mockResolvedValue([
      makeReminder({
        tosDeadlineAt: "2025-01-12T00:00:00.000Z",
        tosRequiredDays: 3
      })
    ]);

    const now = Date.now();
    const scheduledTime = now - 1_000; // on time

    await handleReminderAlarm("subview:tos-warning:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.message).toContain("Terms of Service require cancellation");
    expect(opts.message).not.toContain("while you were away");
  });

  it("returns early when alarm name is not a known reminder", async () => {
    vi.mocked(getReminders).mockResolvedValue([]);

    await handleReminderAlarm("unknown:alarm", Date.now());

    expect(mockNotificationsCreate).not.toHaveBeenCalled();
  });

  it("exactly at 24-hour threshold is not considered late", async () => {
    vi.mocked(getReminders).mockResolvedValue([makeReminder()]);

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const scheduledTime = now - 24 * 60 * 60 * 1000; // exactly 24 hours ago

    await handleReminderAlarm("subview:reminder:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.message).toContain("Reminder due now.");
    expect(opts.message).not.toContain("while you were away");
  });
});

describe("upsertReminderFromDetection - deduplication", () => {
  const baseInput = {
    detection: makeDetection(),
    hostname: "example.com",
    domainKey: "example.com",
    bufferDays: 2
  };

  beforeEach(() => {
    mockAlarmsCreate.mockClear();
    vi.mocked(setReminders).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the existing reminder by default when a duplicate is found", async () => {
    const existing = makeReminder({ id: "rem-existing" });
    vi.mocked(getReminders).mockResolvedValue([existing]);
    vi.mocked(findDuplicateReminder).mockReturnValue(existing);

    const result = await upsertReminderFromDetection(baseInput);

    expect(result.reminder.id).toBe("rem-existing");
    expect(result.duplicateCandidateId).toBe("rem-existing");
    const savedReminders = vi.mocked(setReminders).mock.calls[0][0] as ReminderRecord[];
    expect(savedReminders).toHaveLength(1);
    expect(savedReminders[0].id).toBe("rem-existing");
  });

  it("updates the existing reminder when dedupeAction is update-existing", async () => {
    const existing = makeReminder({ id: "rem-existing" });
    vi.mocked(getReminders).mockResolvedValue([existing]);
    vi.mocked(findDuplicateReminder).mockReturnValue(existing);

    const result = await upsertReminderFromDetection({ ...baseInput, dedupeAction: "update-existing" });

    expect(result.reminder.id).toBe("rem-existing");
    const savedReminders = vi.mocked(setReminders).mock.calls[0][0] as ReminderRecord[];
    expect(savedReminders).toHaveLength(1);
  });

  it("creates a new entry when dedupeAction is keep-both even if duplicate found", async () => {
    const existing = makeReminder({ id: "rem-existing" });
    vi.mocked(getReminders).mockResolvedValue([existing]);
    vi.mocked(findDuplicateReminder).mockReturnValue(existing);

    const result = await upsertReminderFromDetection({ ...baseInput, dedupeAction: "keep-both" });

    expect(result.reminder.id).not.toBe("rem-existing");
    expect(result.duplicateCandidateId).toBe("rem-existing");
    const savedReminders = vi.mocked(setReminders).mock.calls[0][0] as ReminderRecord[];
    expect(savedReminders).toHaveLength(2);
  });

  it("creates a new entry when no duplicate is found", async () => {
    vi.mocked(getReminders).mockResolvedValue([]);
    vi.mocked(findDuplicateReminder).mockReturnValue(null);

    const result = await upsertReminderFromDetection(baseInput);

    expect(result.reminder.id).toMatch(/^rem_/);
    expect(result.duplicateCandidateId).toBeUndefined();
    const savedReminders = vi.mocked(setReminders).mock.calls[0][0] as ReminderRecord[];
    expect(savedReminders).toHaveLength(1);
  });
});
