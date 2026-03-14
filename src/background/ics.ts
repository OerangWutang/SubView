import type { ReminderRecord } from "../shared/types";
import { toIcsLocalDateTime } from "../shared/time";

function toIcsUtcDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function escapeIcsValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function generateIcsForReminder(reminder: ReminderRecord): string {
  const reminderAt = new Date(reminder.reminderAt);
  const endAt = new Date(reminderAt.getTime() + 30 * 60 * 1000);
  const dtstamp = toIcsUtcDateTime(new Date());
  const uid = `${reminder.id}@subview.local`;
  const summary = escapeIcsValue(`Cancel trial for ${reminder.domainKey}`);

  const descriptionLines = [
    `Domain: ${reminder.domainKey}`,
    `Cancel target date: ${new Date(reminder.cancelAt).toLocaleString()}`,
    reminder.manageUrl ? `Manage link: ${reminder.manageUrl}` : "Manage link: not available"
  ];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SubView//EN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsValue(uid)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsLocalDateTime(reminderAt)}`,
    `DTEND:${toIcsLocalDateTime(endAt)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${escapeIcsValue(descriptionLines.join("\\n"))}`,
    reminder.manageUrl ? `URL:${escapeIcsValue(reminder.manageUrl)}` : "",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean);

  return `${lines.join("\r\n")}\r\n`;
}

function downloadFile(url: string, filename: string): Promise<void> {
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

export async function exportReminderAsIcs(reminder: ReminderRecord): Promise<void> {
  const content = generateIcsForReminder(reminder);
  const safeDomain = reminder.domainKey.replace(/[^a-z0-9.-]/gi, "_") || "site";
  const filename = `subview-cancel-${safeDomain}.ics`;
  const url = `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
  await downloadFile(url, filename);
}
