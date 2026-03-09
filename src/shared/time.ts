import { REMINDER_HOUR_LOCAL } from "./constants";

export function computeReminderAtLocalNine(
  cancelDate: Date,
  options?: { now?: Date; devFastTrack?: boolean }
): Date {
  const now = options?.now ?? new Date();
  const cancelAt = new Date(cancelDate);

  if (options?.devFastTrack) {
    return new Date(now.getTime() + 5 * 60 * 1000);
  }

  const remainingMs = cancelAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return now;
  }

  const fallbackInTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
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

  if (remainingMs < 12 * 60 * 60 * 1000 || target.getTime() > cancelAt.getTime()) {
    return fallback;
  }

  return target;
}
