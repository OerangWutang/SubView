export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function uid(prefix = "tg"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function parseCsv(value: string): string[] {
  return uniqueStrings(value.split(",").map((item) => item.trim().toLowerCase()));
}

export function daysUntilDate(isoDate: string): number {
  const now = new Date();
  const target = new Date(isoDate);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((target.getTime() - now.getTime()) / msPerDay);
}

export function computeMonthlyEquivalentCost(pricePerCycle: number, billingCycle: string): number | null {
  switch (billingCycle) {
    case "weekly":
      return (pricePerCycle * 52) / 12;
    case "monthly":
      return pricePerCycle;
    case "yearly":
      return pricePerCycle / 12;
    default:
      return null;
  }
}
