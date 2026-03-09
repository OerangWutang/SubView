import { describe, expect, it } from "vitest";
import { findDuplicateReminder } from "./storage";
import type { ReminderRecord } from "../shared/types";

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem_001",
    hostname: "example.com",
    domainKey: "example.com",
    createdAt: new Date().toISOString(),
    kind: "trial",
    trialDays: 14,
    detectedAt: new Date().toISOString(),
    cancelAt: "2024-06-15T00:00:00.000Z",
    reminderAt: "2024-06-13T09:00:00.000Z",
    bufferDays: 2,
    status: "active",
    ...overrides
  };
}

describe("findDuplicateReminder - dedupe key stability", () => {
  it("finds a duplicate when cancelAt timestamps are on the same UTC day but differ in time", () => {
    const nowMs = new Date("2024-06-01T10:00:00.000Z").getTime();
    const reminder = makeReminder({
      createdAt: "2024-06-01T10:00:00.000Z",
      cancelAt: "2024-06-15T00:01:00.000Z"
    });

    const candidate = {
      domainKey: "example.com",
      kind: "trial" as const,
      trialDays: 14,
      // Same day as reminder.cancelAt but a few hours later (still same UTC date)
      cancelAt: "2024-06-15T08:30:00.000Z"
    };

    const result = findDuplicateReminder([reminder], candidate, nowMs);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("rem_001");
  });

  it("does not find a duplicate when cancelAt dates differ by one day", () => {
    const nowMs = new Date("2024-06-01T10:00:00.000Z").getTime();
    const reminder = makeReminder({
      createdAt: "2024-06-01T10:00:00.000Z",
      cancelAt: "2024-06-15T00:00:00.000Z"
    });

    const candidate = {
      domainKey: "example.com",
      kind: "trial" as const,
      trialDays: 14,
      cancelAt: "2024-06-16T00:00:00.000Z"
    };

    const result = findDuplicateReminder([reminder], candidate, nowMs);
    expect(result).toBeNull();
  });

  it("does not find a duplicate when createdAt is older than 30 minutes", () => {
    const nowMs = new Date("2024-06-01T12:00:00.000Z").getTime();
    const reminder = makeReminder({
      createdAt: "2024-06-01T11:00:00.000Z", // 60 minutes ago
      cancelAt: "2024-06-15T00:00:00.000Z"
    });

    const candidate = {
      domainKey: "example.com",
      kind: "trial" as const,
      trialDays: 14,
      cancelAt: "2024-06-15T00:00:00.000Z"
    };

    const result = findDuplicateReminder([reminder], candidate, nowMs);
    expect(result).toBeNull();
  });

  it("does not match reminders with different domain keys", () => {
    const nowMs = new Date("2024-06-01T10:00:00.000Z").getTime();
    const reminder = makeReminder({
      domainKey: "other.com",
      createdAt: "2024-06-01T10:00:00.000Z",
      cancelAt: "2024-06-15T00:00:00.000Z"
    });

    const candidate = {
      domainKey: "example.com",
      kind: "trial" as const,
      trialDays: 14,
      cancelAt: "2024-06-15T00:00:00.000Z"
    };

    const result = findDuplicateReminder([reminder], candidate, nowMs);
    expect(result).toBeNull();
  });

  it("does not match reminders with different trialDays", () => {
    const nowMs = new Date("2024-06-01T10:00:00.000Z").getTime();
    const reminder = makeReminder({
      trialDays: 7,
      createdAt: "2024-06-01T10:00:00.000Z",
      cancelAt: "2024-06-15T00:00:00.000Z"
    });

    const candidate = {
      domainKey: "example.com",
      kind: "trial" as const,
      trialDays: 14,
      cancelAt: "2024-06-15T00:00:00.000Z"
    };

    const result = findDuplicateReminder([reminder], candidate, nowMs);
    expect(result).toBeNull();
  });
});
