import { getDomainKey, normalizeDomainInput } from "../shared/domain";
import { sendMessage } from "../shared/messaging";
import type {
  ImportExportBlob,
  SitePolicy,
  UserSettings
} from "../shared/types";
import { parseCsv } from "../shared/utils";
import { MODAL_BUFFER_MIN, MODAL_BUFFER_MAX } from "../shared/constants";

function setStatus(text: string): void {
  const status = document.getElementById("status") as HTMLSpanElement;
  status.textContent = text;
}

function setPermissionState(text: string): void {
  const state = document.getElementById("permState") as HTMLSpanElement;
  state.textContent = text;
}

function hasAllSitesPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: ["<all_urls>"] }, (granted) => resolve(Boolean(granted)));
  });
}

function renderDisabledDomains(settings: UserSettings): void {
  const list = document.getElementById("disabledDomains") as HTMLUListElement;
  list.innerHTML = "";

  for (const domain of settings.disabledDomainKeys) {
    const li = document.createElement("li");
    li.textContent = domain;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.style.marginLeft = "8px";

    remove.addEventListener("click", async () => {
      const next = (settings.disabledDomainKeys || []).filter((item) => item !== domain);
      const updated = await sendMessage<UserSettings>({
        type: "UPSERT_SETTINGS",
        payload: { disabledDomainKeys: next }
      });
      Object.assign(settings, updated);
      renderDisabledDomains(settings);
      setStatus("Disabled domains updated");
    });

    li.appendChild(remove);
    list.appendChild(li);
  }
}

function toCsv(values: string[]): string {
  return values.join(", ");
}

async function init(): Promise<void> {
  let settings = await sendMessage<UserSettings>({ type: "GET_SETTINGS" });

  const enabledInput = document.getElementById("enabled") as HTMLInputElement;
  const requestOnStartupInput = document.getElementById("requestOnStartup") as HTMLInputElement;
  const debugOverlayInput = document.getElementById("debugOverlay") as HTMLInputElement;
  const bufferDaysInput = document.getElementById("bufferDays") as HTMLInputElement;

  const trialKeywordsInput = document.getElementById("trialKeywords") as HTMLInputElement;
  const renewalKeywordsInput = document.getElementById("renewalKeywords") as HTMLInputElement;
  const subscriptionKeywordsInput = document.getElementById("subscriptionKeywords") as HTMLInputElement;
  const commitKeywordsInput = document.getElementById("commitKeywords") as HTMLInputElement;

  enabledInput.checked = settings.enabled;
  requestOnStartupInput.checked = settings.requestAllSitesOnStartup;
  debugOverlayInput.checked = settings.debugOverlay;
  bufferDaysInput.value = String(settings.defaultBufferDays);
  bufferDaysInput.min = String(MODAL_BUFFER_MIN);
  bufferDaysInput.max = String(MODAL_BUFFER_MAX);

  trialKeywordsInput.value = toCsv(settings.keywordOverrides.trial);
  renewalKeywordsInput.value = toCsv(settings.keywordOverrides.renewal);
  subscriptionKeywordsInput.value = toCsv(settings.keywordOverrides.subscription);
  commitKeywordsInput.value = toCsv(settings.keywordOverrides.commit);

  renderDisabledDomains(settings);

  const saveGeneralSettings = async (): Promise<void> => {
    settings = await sendMessage<UserSettings>({
      type: "UPSERT_SETTINGS",
      payload: {
        enabled: enabledInput.checked,
        requestAllSitesOnStartup: requestOnStartupInput.checked,
        debugOverlay: debugOverlayInput.checked,
        defaultBufferDays: Number(bufferDaysInput.value),
        keywordOverrides: {
          trial: parseCsv(trialKeywordsInput.value),
          renewal: parseCsv(renewalKeywordsInput.value),
          subscription: parseCsv(subscriptionKeywordsInput.value),
          commit: parseCsv(commitKeywordsInput.value)
        }
      }
    });
    setStatus("Settings saved");
  };

  [
    enabledInput,
    requestOnStartupInput,
    debugOverlayInput,
    bufferDaysInput,
    trialKeywordsInput,
    renewalKeywordsInput,
    subscriptionKeywordsInput,
    commitKeywordsInput
  ].forEach((element) => {
    element.addEventListener("change", () => {
      void saveGeneralSettings();
    });
  });

  const requestPermsButton = document.getElementById("requestPerms") as HTMLButtonElement;
  const notNowButton = document.getElementById("notNow") as HTMLButtonElement;

  setPermissionState((await hasAllSitesPermission()) ? "All-sites permission already granted" : "All-sites permission not granted");

  requestPermsButton.addEventListener("click", async () => {
    const result = await sendMessage<{ granted: boolean }>({ type: "REQUEST_HOST_PERMISSIONS" });
    setPermissionState(result.granted ? "All-sites permission granted" : "Permission not granted");
  });

  notNowButton.addEventListener("click", async () => {
    settings = await sendMessage<UserSettings>({
      type: "UPSERT_SETTINGS",
      payload: { requestAllSitesOnStartup: false }
    });
    requestOnStartupInput.checked = settings.requestAllSitesOnStartup;
    setPermissionState("Permission request skipped");
  });

  const addDomainButton = document.getElementById("addDomain") as HTMLButtonElement;
  const domainInput = document.getElementById("domainInput") as HTMLInputElement;

  addDomainButton.addEventListener("click", async () => {
    const normalized = normalizeDomainInput(domainInput.value);
    if (!normalized) {
      setStatus("Enter a valid domain");
      return;
    }

    const domainKey = getDomainKey(normalized);
    const disabled = Array.from(new Set([...(settings.disabledDomainKeys || []), domainKey]));
    settings = await sendMessage<UserSettings>({
      type: "UPSERT_SETTINGS",
      payload: { disabledDomainKeys: disabled }
    });

    domainInput.value = "";
    renderDisabledDomains(settings);
    setStatus("Domain disabled");
  });

  const savePolicyButton = document.getElementById("savePolicy") as HTMLButtonElement;
  savePolicyButton.addEventListener("click", async () => {
    const domain = normalizeDomainInput((document.getElementById("policyDomain") as HTMLInputElement).value);
    if (!domain) {
      setStatus("Provide a domain for policy override");
      return;
    }

    const domainKey = getDomainKey(domain);
    const difficulty = (document.getElementById("policyDifficulty") as HTMLSelectElement).value as SitePolicy["difficulty"];
    const method = (document.getElementById("policyMethod") as HTMLSelectElement).value as SitePolicy["method"];
    const notes = (document.getElementById("policyNotes") as HTMLTextAreaElement).value.trim();
    const steps = (document.getElementById("policySteps") as HTMLTextAreaElement).value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const manageUrl = (document.getElementById("policyManageUrl") as HTMLInputElement).value.trim();
    const tosRequiredDaysRaw = Number((document.getElementById("policyTosRequiredDays") as HTMLInputElement).value);
    const tosRequiredDays = tosRequiredDaysRaw > 0 ? tosRequiredDaysRaw : undefined;

    const policy: SitePolicy = {
      difficulty,
      method,
      notes: notes || undefined,
      steps: steps.length > 0 ? steps : undefined,
      manageUrl: manageUrl || undefined,
      tosRequiredDays
    };

    await sendMessage({
      type: "UPSERT_SITE_POLICY_OVERRIDE",
      payload: { domainKey, policy }
    });

    setStatus("Policy override saved");
  });

  const submitReportButton = document.getElementById("submitReport") as HTMLButtonElement;
  submitReportButton.addEventListener("click", async () => {
    const domain = normalizeDomainInput((document.getElementById("reportDomain") as HTMLInputElement).value);
    if (!domain) {
      setStatus("Provide a report domain");
      return;
    }

    const difficulty = (document.getElementById("reportDifficulty") as HTMLSelectElement).value as "easy" | "medium" | "hard";
    const notes = (document.getElementById("reportNotes") as HTMLTextAreaElement).value.trim();

    await sendMessage({
      type: "UPSERT_REPORT",
      payload: {
        report: {
          domainKey: getDomainKey(domain),
          hostname: domain,
          difficulty,
          notes: notes || undefined
        }
      }
    });

    setStatus("Report stored locally");
  });

  const exportDataButton = document.getElementById("exportData") as HTMLButtonElement;
  exportDataButton.addEventListener("click", async () => {
    const data = await sendMessage<ImportExportBlob>({ type: "EXPORT_LOCAL_DATA" });
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`;
    const filename = `subview-export-${new Date().toISOString().slice(0, 10)}.json`;

    chrome.downloads.download({ url, filename, saveAs: true });
    setStatus("Export started");
  });

  const importDataButton = document.getElementById("importData") as HTMLButtonElement;
  importDataButton.addEventListener("click", async () => {
    const input = document.getElementById("importFile") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      setStatus("Choose a JSON file to import");
      return;
    }

    const text = await file.text();
    let parsed: ImportExportBlob;
    try {
      parsed = JSON.parse(text) as ImportExportBlob;
    } catch {
      setStatus("Import failed: invalid JSON file");
      return;
    }
    await sendMessage({ type: "IMPORT_LOCAL_DATA", payload: { data: parsed } });
    settings = await sendMessage<UserSettings>({ type: "GET_SETTINGS" });
    renderDisabledDomains(settings);
    setStatus("Import completed");
  });
}

void init().catch((error) => {
  console.error("SubView options failed", error);
  setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
});
