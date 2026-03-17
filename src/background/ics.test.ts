import { describe, expect, it } from "vitest";
import { generateIcsForReminder } from "./ics";
import type { ReminderRecord } from "../shared/types";

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
    reminderAt: "2024-10-15T12:00:00.000Z",
    bufferDays: 2,
    status: "active",
    ...overrides
  };
}

describe("generateIcsForReminder", () => {
  it("formats DTSTART as a correctly padded UTC ICS datetime", () => {
    const reminder = makeReminder({ reminderAt: "2024-10-15T12:00:00.000Z" });
    const ics = generateIcsForReminder(reminder);
    expect(ics).toContain("DTSTART:20241015T120000Z");
  });

  it("formats DTEND as 30 minutes after DTSTART", () => {
    const reminder = makeReminder({ reminderAt: "2024-10-15T12:00:00.000Z" });
    const ics = generateIcsForReminder(reminder);
    expect(ics).toContain("DTEND:20241015T123000Z");
  });

  it("zero-pads single-digit month, day, hour, minute, second values", () => {
    // 2025-02-03T04:05:06Z should produce 20250203T040506Z
    const reminder = makeReminder({ reminderAt: "2025-02-03T04:05:06.000Z" });
    const ics = generateIcsForReminder(reminder);
    expect(ics).toContain("DTSTART:20250203T040506Z");
  });

  it("includes a Z suffix (UTC indicator) on datetime fields", () => {
    const reminder = makeReminder({ reminderAt: "2024-10-15T12:00:00.000Z" });
    const ics = generateIcsForReminder(reminder);
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  it("produces a valid ICS structure with required fields", () => {
    const reminder = makeReminder();
    const ics = generateIcsForReminder(reminder);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });
});
