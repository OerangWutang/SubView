import { describe, expect, it, vi } from "vitest";
import { findDuplicateReminder } from "./storage";
import type { ReminderRecord } from "../shared/types";

vi.stubGlobal("chrome", {
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
    session: { get: vi.fn(), set: vi.fn() }
  }
});

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem-001",
    createdAt: new Date().toISOString(),
    hostname: "example.com",
    domainKey: "example.com",
    kind: "trial",
    trialDays: 14,
    detectedAt: new Date().toISOString(),
    cancelAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
    reminderAt: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString(),
    bufferDays: 2,
    status: "active",
    ...overrides
  };
}

describe("findDuplicateReminder", () => {
  const now = Date.now();
  const cancelAt = new Date(now + 12 * 24 * 60 * 60 * 1000).toISOString();
  const candidate = {
    domainKey: "example.com",
    kind: "trial" as const,
    trialDays: 14,
    cancelAt
  };

  it("returns a matching active reminder", () => {
    const reminders = [makeReminder({ cancelAt })];
    expect(findDuplicateReminder(reminders, candidate, now)).toBe(reminders[0]);
  });

  it("ignores completed reminders", () => {
    const reminders = [makeReminder({ cancelAt, status: "completed" })];
    expect(findDuplicateReminder(reminders, candidate, now)).toBeNull();
  });

  it("ignores dismissed reminders", () => {
    const reminders = [makeReminder({ cancelAt, status: "dismissed" })];
    expect(findDuplicateReminder(reminders, candidate, now)).toBeNull();
  });

  it("returns null when the matching reminder was created more than 30 minutes ago", () => {
    const oldCreatedAt = new Date(now - 31 * 60 * 1000).toISOString();
    const reminders = [makeReminder({ cancelAt, createdAt: oldCreatedAt })];
    expect(findDuplicateReminder(reminders, candidate, now)).toBeNull();
  });

  it("returns null when domainKey differs", () => {
    const reminders = [makeReminder({ cancelAt, domainKey: "other.com" })];
    expect(findDuplicateReminder(reminders, candidate, now)).toBeNull();
  });
});
