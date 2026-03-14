import { describe, expect, it } from "vitest";
import { findDuplicateReminder } from "./storage";
import type { ReminderRecord } from "../shared/types";

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  const base: ReminderRecord = {
    id: "rem_test",
    hostname: "example.com",
    domainKey: "example.com",
    createdAt: new Date().toISOString(),
    kind: "trial",
    trialDays: 14,
    detectedAt: new Date().toISOString(),
    cancelAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
    reminderAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
    bufferDays: 2,
    status: "active"
  };
  return { ...base, ...overrides };
}

describe("findDuplicateReminder", () => {
  const candidate = {
    domainKey: "example.com",
    kind: "trial" as const,
    trialDays: 14,
    cancelAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString()
  };

  it("returns a matching active reminder within the dedup window", () => {
    const reminder = makeReminder();
    const result = findDuplicateReminder([reminder], candidate, Date.now());
    expect(result).not.toBeNull();
    expect(result?.id).toBe("rem_test");
  });

  it("ignores completed reminders even if they match all other criteria", () => {
    const completed = makeReminder({ status: "completed" });
    const result = findDuplicateReminder([completed], candidate, Date.now());
    expect(result).toBeNull();
  });

  it("ignores dismissed reminders even if they match all other criteria", () => {
    const dismissed = makeReminder({ status: "dismissed" });
    const result = findDuplicateReminder([dismissed], candidate, Date.now());
    expect(result).toBeNull();
  });

  it("returns null when the reminder was created outside the dedup window", () => {
    const old = makeReminder({
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString()
    });
    const result = findDuplicateReminder([old], candidate, Date.now());
    expect(result).toBeNull();
  });

  it("returns null when domainKey differs", () => {
    const other = makeReminder({ domainKey: "other.com" });
    const result = findDuplicateReminder([other], candidate, Date.now());
    expect(result).toBeNull();
  });
});
