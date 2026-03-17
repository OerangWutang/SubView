import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReminderAlarm } from "./reminders";
import type { ReminderRecord } from "../shared/types";

vi.mock("./storage", () => ({
  getReminders: vi.fn(),
  putNotificationMapItem: vi.fn().mockResolvedValue(undefined),
  getReminderIdFromNotification: vi.fn(),
  findDuplicateReminder: vi.fn(),
  setReminders: vi.fn()
}));

const { getReminders } = await import("./storage");

const mockNotificationsCreate = vi.fn((_id: string, _opts: unknown, cb?: (id: string) => void) => {
  if (cb) cb(_id);
});

vi.stubGlobal("chrome", {
  notifications: {
    create: mockNotificationsCreate
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

describe("handleReminderAlarm - delayed alarm urgency", () => {
  beforeEach(() => {
    mockNotificationsCreate.mockClear();
  });

  afterEach(() => {
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

    const now = Date.now();
    const scheduledTime = now - 24 * 60 * 60 * 1000; // exactly 24 hours ago

    await handleReminderAlarm("subview:reminder:rem-001", scheduledTime);

    expect(mockNotificationsCreate).toHaveBeenCalledOnce();
    const opts = mockNotificationsCreate.mock.calls[0][1] as { title: string; message: string };
    expect(opts.message).toContain("Reminder due now.");
    expect(opts.message).not.toContain("while you were away");
  });
});
