"use strict";
(() => {
  // src/shared/messaging.ts
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error ?? "Unknown extension error"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  // src/popup/popup.ts
  function renderReminders(items) {
    const list = document.getElementById("reminders");
    list.innerHTML = "";
    const sorted = [...items].filter((item) => item.status === "active").sort((a, b) => new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime()).slice(0, 5);
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
  function renderDetections(items) {
    const list = document.getElementById("detections");
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
  async function init() {
    const [settings, reminders, detections] = await Promise.all([
      sendMessage({ type: "GET_SETTINGS" }),
      sendMessage({ type: "GET_REMINDERS" }),
      sendMessage({ type: "GET_DETECTIONS_RECENT" })
    ]);
    const enabledInput = document.getElementById("enabled");
    const debugOverlayInput = document.getElementById("debugOverlay");
    const openOptionsButton = document.getElementById("openOptions");
    enabledInput.checked = settings.enabled;
    debugOverlayInput.checked = settings.debugOverlay;
    enabledInput.addEventListener("change", async () => {
      await sendMessage({
        type: "UPSERT_SETTINGS",
        payload: { enabled: enabledInput.checked }
      });
    });
    debugOverlayInput.addEventListener("change", async () => {
      await sendMessage({
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
    console.error("TrialGuard popup failed", error);
  });
})();
//# sourceMappingURL=popup.js.map
