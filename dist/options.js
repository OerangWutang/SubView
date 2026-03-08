"use strict";
(() => {
  // src/shared/domain.ts
  var MULTI_PART_PUBLIC_SUFFIXES = /* @__PURE__ */ new Set([
    "ac.jp",
    "ac.nz",
    "ac.uk",
    "asn.au",
    "co.in",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.uk",
    "com.au",
    "com.br",
    "com.cn",
    "com.hk",
    "com.mx",
    "com.sg",
    "com.tr",
    "edu.au",
    "edu.cn",
    "edu.hk",
    "edu.tr",
    "gen.nz",
    "geek.nz",
    "go.jp",
    "gov.au",
    "gov.br",
    "gov.cn",
    "gov.hk",
    "gov.in",
    "gov.nz",
    "gov.uk",
    "iwi.nz",
    "lg.jp",
    "maori.nz",
    "me.uk",
    "mil.br",
    "mil.cn",
    "ne.jp",
    "net.au",
    "net.br",
    "net.cn",
    "net.in",
    "net.nz",
    "net.uk",
    "or.jp",
    "org.au",
    "org.br",
    "org.cn",
    "org.hk",
    "org.in",
    "org.nz",
    "org.uk",
    "plc.uk",
    "sch.uk",
    "school.nz"
  ]);
  var GENERIC_COUNTRY_SECOND_LEVELS = /* @__PURE__ */ new Set(["ac", "co", "com", "edu", "gov", "mil", "net", "org"]);
  function cleanHostname(hostname) {
    return hostname.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  }
  function normalizeDomainInput(input) {
    const clean = input.trim().toLowerCase();
    if (!clean) {
      return "";
    }
    try {
      const asUrl = clean.startsWith("http://") || clean.startsWith("https://") ? clean : `https://${clean}`;
      return cleanHostname(new URL(asUrl).hostname);
    } catch {
      const withoutPath = clean.split(/[/?#]/)[0];
      const withoutPort = withoutPath.replace(/:(\d+)$/, "");
      return cleanHostname(withoutPort);
    }
  }
  function isIpLike(hostname) {
    if (!hostname) {
      return false;
    }
    if (hostname === "localhost" || hostname.includes(":")) {
      return true;
    }
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  }
  function getPublicSuffixLabelCount(parts) {
    if (parts.length < 2) {
      return 1;
    }
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
      return 2;
    }
    const tld = parts[parts.length - 1];
    const secondLevel = parts[parts.length - 2];
    if (tld.length === 2 && GENERIC_COUNTRY_SECOND_LEVELS.has(secondLevel) && parts.length >= 3) {
      return 2;
    }
    return 1;
  }
  function getDomainKey(hostname) {
    const normalized = normalizeDomainInput(hostname);
    if (!normalized || isIpLike(normalized)) {
      return normalized;
    }
    const parts = normalized.split(".").filter(Boolean);
    if (parts.length <= 2) {
      return normalized;
    }
    const suffixLabelCount = getPublicSuffixLabelCount(parts);
    const registrableLabelCount = suffixLabelCount + 1;
    if (parts.length <= registrableLabelCount) {
      return normalized;
    }
    return parts.slice(-registrableLabelCount).join(".");
  }

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

  // src/shared/utils.ts
  function uniqueStrings(values) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
  function parseCsv(value) {
    return uniqueStrings(value.split(",").map((item) => item.trim().toLowerCase()));
  }

  // src/options/options.ts
  function setStatus(text) {
    const status = document.getElementById("status");
    status.textContent = text;
  }
  function setPermissionState(text) {
    const state = document.getElementById("permState");
    state.textContent = text;
  }
  function hasAllSitesPermission() {
    return new Promise((resolve) => {
      chrome.permissions.contains({ origins: ["<all_urls>"] }, (granted) => resolve(Boolean(granted)));
    });
  }
  function renderDisabledDomains(settings) {
    const list = document.getElementById("disabledDomains");
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
        const updated = await sendMessage({
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
  function toCsv(values) {
    return values.join(", ");
  }
  async function init() {
    let settings = await sendMessage({ type: "GET_SETTINGS" });
    const enabledInput = document.getElementById("enabled");
    const requestOnStartupInput = document.getElementById("requestOnStartup");
    const debugOverlayInput = document.getElementById("debugOverlay");
    const bufferDaysInput = document.getElementById("bufferDays");
    const trialKeywordsInput = document.getElementById("trialKeywords");
    const renewalKeywordsInput = document.getElementById("renewalKeywords");
    const subscriptionKeywordsInput = document.getElementById("subscriptionKeywords");
    const commitKeywordsInput = document.getElementById("commitKeywords");
    enabledInput.checked = settings.enabled;
    requestOnStartupInput.checked = settings.requestAllSitesOnStartup;
    debugOverlayInput.checked = settings.debugOverlay;
    bufferDaysInput.value = String(settings.defaultBufferDays);
    trialKeywordsInput.value = toCsv(settings.keywordOverrides.trial);
    renewalKeywordsInput.value = toCsv(settings.keywordOverrides.renewal);
    subscriptionKeywordsInput.value = toCsv(settings.keywordOverrides.subscription);
    commitKeywordsInput.value = toCsv(settings.keywordOverrides.commit);
    renderDisabledDomains(settings);
    const saveGeneralSettings = async () => {
      settings = await sendMessage({
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
    const requestPermsButton = document.getElementById("requestPerms");
    const notNowButton = document.getElementById("notNow");
    setPermissionState(await hasAllSitesPermission() ? "All-sites permission already granted" : "All-sites permission not granted");
    requestPermsButton.addEventListener("click", async () => {
      const result = await sendMessage({ type: "REQUEST_HOST_PERMISSIONS" });
      setPermissionState(result.granted ? "All-sites permission granted" : "Permission not granted");
    });
    notNowButton.addEventListener("click", async () => {
      settings = await sendMessage({
        type: "UPSERT_SETTINGS",
        payload: { requestAllSitesOnStartup: false }
      });
      requestOnStartupInput.checked = settings.requestAllSitesOnStartup;
      setPermissionState("Permission request skipped");
    });
    const addDomainButton = document.getElementById("addDomain");
    const domainInput = document.getElementById("domainInput");
    addDomainButton.addEventListener("click", async () => {
      const normalized = normalizeDomainInput(domainInput.value);
      if (!normalized) {
        setStatus("Enter a valid domain");
        return;
      }
      const domainKey = getDomainKey(normalized);
      const disabled = Array.from(/* @__PURE__ */ new Set([...settings.disabledDomainKeys || [], domainKey]));
      settings = await sendMessage({
        type: "UPSERT_SETTINGS",
        payload: { disabledDomainKeys: disabled }
      });
      domainInput.value = "";
      renderDisabledDomains(settings);
      setStatus("Domain disabled");
    });
    const savePolicyButton = document.getElementById("savePolicy");
    savePolicyButton.addEventListener("click", async () => {
      const domain = normalizeDomainInput(document.getElementById("policyDomain").value);
      if (!domain) {
        setStatus("Provide a domain for policy override");
        return;
      }
      const domainKey = getDomainKey(domain);
      const difficulty = document.getElementById("policyDifficulty").value;
      const method = document.getElementById("policyMethod").value;
      const notes = document.getElementById("policyNotes").value.trim();
      const steps = document.getElementById("policySteps").value.split("\n").map((line) => line.trim()).filter(Boolean);
      const manageUrl = document.getElementById("policyManageUrl").value.trim();
      const policy = {
        difficulty,
        method,
        notes: notes || void 0,
        steps: steps.length > 0 ? steps : void 0,
        manageUrl: manageUrl || void 0
      };
      await sendMessage({
        type: "UPSERT_SITE_POLICY_OVERRIDE",
        payload: { domainKey, policy }
      });
      setStatus("Policy override saved");
    });
    const submitReportButton = document.getElementById("submitReport");
    submitReportButton.addEventListener("click", async () => {
      const domain = normalizeDomainInput(document.getElementById("reportDomain").value);
      if (!domain) {
        setStatus("Provide a report domain");
        return;
      }
      const difficulty = document.getElementById("reportDifficulty").value;
      const notes = document.getElementById("reportNotes").value.trim();
      await sendMessage({
        type: "UPSERT_REPORT",
        payload: {
          report: {
            domainKey: getDomainKey(domain),
            hostname: domain,
            difficulty,
            notes: notes || void 0
          }
        }
      });
      setStatus("Report stored locally");
    });
    const exportDataButton = document.getElementById("exportData");
    exportDataButton.addEventListener("click", async () => {
      const data = await sendMessage({ type: "EXPORT_LOCAL_DATA" });
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`;
      const filename = `trialguard-export-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
      chrome.downloads.download({ url, filename, saveAs: true });
      setStatus("Export started");
    });
    const importDataButton = document.getElementById("importData");
    importDataButton.addEventListener("click", async () => {
      const input = document.getElementById("importFile");
      const file = input.files?.[0];
      if (!file) {
        setStatus("Choose a JSON file to import");
        return;
      }
      const text = await file.text();
      const parsed = JSON.parse(text);
      await sendMessage({ type: "IMPORT_LOCAL_DATA", payload: { data: parsed } });
      settings = await sendMessage({ type: "GET_SETTINGS" });
      renderDisabledDomains(settings);
      setStatus("Import completed");
    });
  }
  void init().catch((error) => {
    console.error("TrialGuard options failed", error);
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  });
})();
//# sourceMappingURL=options.js.map
