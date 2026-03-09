import { describe, expect, it } from "vitest";
import { generateIcsForReminder } from "./ics";
import type { ReminderRecord } from "../shared/types";

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "rem_test1",
    hostname: "example.com",
    domainKey: "example.com",
    createdAt: "2024-06-01T00:00:00.000Z",
    kind: "trial",
    trialDays: 14,
    detectedAt: "2024-06-01T00:00:00.000Z",
    cancelAt: "2024-06-15T00:00:00.000Z",
    reminderAt: "2024-06-13T09:00:00.000Z",
    bufferDays: 2,
    manageUrl: "https://example.com/manage",
    status: "active",
    ...overrides
  };
}

describe("generateIcsForReminder", () => {
  it("emits DTSTAMP, DTSTART and DTEND all as UTC (Z-suffix) timestamps", () => {
    const ics = generateIcsForReminder(makeReminder());

    const dtstamp = ics.match(/^DTSTAMP:(.+)$/m)?.[1];
    const dtstart = ics.match(/^DTSTART:(.+)$/m)?.[1];
    const dtend = ics.match(/^DTEND:(.+)$/m)?.[1];

    expect(dtstamp).toMatch(/^\d{8}T\d{6}Z$/);
    expect(dtstart).toMatch(/^\d{8}T\d{6}Z$/);
    expect(dtend).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("DTSTART matches the reminder reminderAt field in UTC", () => {
    const reminder = makeReminder({ reminderAt: "2024-06-13T09:00:00.000Z" });
    const ics = generateIcsForReminder(reminder);

    const dtstart = ics.match(/^DTSTART:(.+)$/m)?.[1];
    expect(dtstart).toBe("20240613T090000Z");
  });

  it("DTEND is 30 minutes after DTSTART", () => {
    const reminder = makeReminder({ reminderAt: "2024-06-13T09:00:00.000Z" });
    const ics = generateIcsForReminder(reminder);

    const dtend = ics.match(/^DTEND:(.+)$/m)?.[1];
    expect(dtend).toBe("20240613T093000Z");
  });

  it("produces a valid VCALENDAR/VEVENT structure", () => {
    const ics = generateIcsForReminder(makeReminder());

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
  });

  it("includes manage URL when present", () => {
    const reminder = makeReminder({ manageUrl: "https://example.com/manage" });
    const ics = generateIcsForReminder(reminder);
    expect(ics).toContain("URL:https://example.com/manage");
  });

  it("omits URL line when manageUrl is absent", () => {
    const reminder = makeReminder({ manageUrl: undefined });
    const ics = generateIcsForReminder(reminder);
    expect(ics).not.toContain("URL:");
  });
});
