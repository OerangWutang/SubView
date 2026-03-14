import { sendMessage } from "../shared/messaging";
import type { DetectionEvent, ReminderRecord, UserSettings } from "../shared/types";
import { computeMonthlyEquivalentCost, daysUntilDate } from "../shared/utils";

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function renderReminders(items: ReminderRecord[]): void {
  const list = document.getElementById("reminders") as HTMLElement;
  list.innerHTML = "";

  const sorted = [...items]
    .filter((item) => item.status === "active")
    .sort((a, b) => new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime());

  if (sorted.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No active subscriptions yet";
    list.appendChild(empty);
    renderSpendingSummary([]);
    return;
  }

  for (const item of sorted) {
    const li = document.createElement("li");
    li.className = "sub-item";

    const nameRow = document.createElement("div");
    nameRow.className = "sub-name";
    nameRow.textContent = item.domainKey;

    const detailsRow = document.createElement("div");
    detailsRow.className = "sub-details";

    const details: string[] = [];

    // Days until renewal
    if (item.renewalDate) {
      const daysLeft = daysUntilDate(item.renewalDate);
      details.push(daysLeft > 0 ? `Renews in ${daysLeft}d` : "Renewal past due");
    } else {
      const daysLeft = daysUntilDate(item.cancelAt);
      if (daysLeft > 0) {
        details.push(`~${daysLeft}d remaining`);
      }
    }

    // Cost per billing cycle
    if (item.pricePerCycle != null && item.billingCycle) {
      details.push(`${formatCurrency(item.pricePerCycle)}/${item.billingCycle}`);
    }

    // Next payment date
    if (item.renewalDate) {
      details.push(`Next: ${new Date(item.renewalDate).toLocaleDateString()}`);
    }

    detailsRow.textContent = details.join(" · ");

    // True cancellation deadline (ToS)
    if (item.tosDeadlineAt) {
      const tosRow = document.createElement("div");
      tosRow.className = "sub-tos";
      const tosDeadlineDays = daysUntilDate(item.tosDeadlineAt);
      tosRow.textContent = `⚠️ Cancel by ${new Date(item.tosDeadlineAt).toLocaleDateString()} (ToS: ${item.tosRequiredDays}d required)`;
      if (tosDeadlineDays <= 3) {
        tosRow.style.color = "#dc2626";
        tosRow.style.fontWeight = "600";
      }
      li.appendChild(nameRow);
      li.appendChild(detailsRow);
      li.appendChild(tosRow);
    } else {
      li.appendChild(nameRow);
      li.appendChild(detailsRow);
    }

    list.appendChild(li);
  }

  renderSpendingSummary(sorted);
}

function renderSpendingSummary(items: ReminderRecord[]): void {
  const summaryEl = document.getElementById("spendingSummary");
  if (!summaryEl) return;

  let totalMonthly = 0;
  let hasAny = false;

  for (const item of items) {
    if (item.pricePerCycle != null && item.billingCycle) {
      const monthly = computeMonthlyEquivalentCost(item.pricePerCycle, item.billingCycle);
      if (monthly !== null) {
        totalMonthly += monthly;
        hasAny = true;
      }
    }
  }

  if (!hasAny) {
    summaryEl.textContent = "";
    return;
  }

  const totalYearly = totalMonthly * 12;
  summaryEl.textContent = `Total: ${formatCurrency(totalMonthly)}/mo · ${formatCurrency(totalYearly)}/yr`;
}

function renderDetections(items: DetectionEvent[]): void {
  const list = document.getElementById("detections") as HTMLUListElement;
  list.innerHTML = "";

  const sorted = [...items].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 5);

  if (sorted.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No detections yet";
    list.appendChild(empty);
    return;
  }

  for (const item of sorted) {
    const li = document.createElement("li");
    li.textContent = `${item.domainKey} (${item.kind}, ${item.confidence.toFixed(2)})`;
    list.appendChild(li);
  }
}

async function init(): Promise<void> {
  const [settings, reminders, detections] = await Promise.all([
    sendMessage<UserSettings>({ type: "GET_SETTINGS" }),
    sendMessage<ReminderRecord[]>({ type: "GET_REMINDERS" }),
    sendMessage<DetectionEvent[]>({ type: "GET_DETECTIONS_RECENT" })
  ]);

  const enabledInput = document.getElementById("enabled") as HTMLInputElement;
  const debugOverlayInput = document.getElementById("debugOverlay") as HTMLInputElement;
  const openOptionsButton = document.getElementById("openOptions") as HTMLButtonElement;

  enabledInput.checked = settings.enabled;
  debugOverlayInput.checked = settings.debugOverlay;

  enabledInput.addEventListener("change", async () => {
    await sendMessage<UserSettings>({
      type: "UPSERT_SETTINGS",
      payload: { enabled: enabledInput.checked }
    });
  });

  debugOverlayInput.addEventListener("change", async () => {
    await sendMessage<UserSettings>({
      type: "UPSERT_SETTINGS",
      payload: { debugOverlay: debugOverlayInput.checked }
    });
  });

  openOptionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  renderReminders(reminders);
  renderDetections(detections);
}

void init().catch((error) => {
  console.error("SubView popup failed", error);
});
