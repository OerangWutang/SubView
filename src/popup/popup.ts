import { sendMessage } from "../shared/messaging";
import type { DetectionEvent, ReminderRecord, UserSettings } from "../shared/types";

function renderReminders(items: ReminderRecord[]): void {
  const list = document.getElementById("reminders") as HTMLUListElement;
  list.innerHTML = "";

  const sorted = [...items]
    .filter((item) => item.status === "active")
    .sort((a, b) => new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime())
    .slice(0, 5);

  if (sorted.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No reminders yet";
    list.appendChild(empty);
    return;
  }

  for (const item of sorted) {
    const li = document.createElement("li");
    li.textContent = `${item.domainKey} - ${new Date(item.reminderAt).toLocaleDateString()}`;
    list.appendChild(li);
  }
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
