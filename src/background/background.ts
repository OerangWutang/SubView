import type { Message, MessageResponse, RuntimeState, UserReport } from "../shared/types";
import {
  appendDetectionEvent,
  appendReport,
  clearPendingDetectionForTab,
  consumePendingDetectionForTab,
  containsOrigins,
  ensureBaseDarkpatternsLoaded,
  exportLocalData,
  getDetectionsRecent,
  getReminders,
  getSettings,
  getSitePolicy,
  importLocalData,
  pruneNotificationMap,
  requestOrigins,
  runMigrations,
  setPendingDetectionForTab,
  upsertSettings,
  upsertUserPolicyOverride
} from "./storage";
import {
  getReminderById,
  handleNotificationButtonClicked,
  handleNotificationClicked,
  handleReminderAlarm,
  rehydrateReminderAlarms,
  upsertReminderFromDetection
} from "./reminders";
import { exportReminderAsIcs } from "./ics";
import { getDomainKey, getHostname } from "../shared/domain";
import { uid } from "../shared/utils";

type RegisteredScript = chrome.scripting.RegisteredContentScript;
const DYNAMIC_CONTENT_SCRIPT_ID = "subview-content";

function getRegisteredContentScripts(ids?: string[]): Promise<RegisteredScript[]> {
  return new Promise((resolve) => {
    chrome.scripting.getRegisteredContentScripts(ids ? { ids } : {}, (scripts) => resolve(scripts));
  });
}

function registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.registerContentScripts(scripts, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function unregisterContentScripts(ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.scripting.unregisterContentScripts({ ids }, () => resolve());
  });
}

async function removeLegacyContentScripts(): Promise<void> {
  // Remove any previously registered dynamic content scripts for "contentScript.js"
  // that use legacy IDs, to avoid duplicate executions after ID changes.
  const scripts = await getRegisteredContentScripts();
  const legacyIds = scripts
    .filter((script: RegisteredScript) => {
      const usesContentScript =
        Array.isArray((script as any).js) &&
        (script as any).js.includes("contentScript.js");
      return usesContentScript && script.id !== DYNAMIC_CONTENT_SCRIPT_ID;
    })
    .map((script) => script.id);

  if (legacyIds.length > 0) {
    await unregisterContentScripts(legacyIds);
  }
}

function queryTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => resolve(tabs));
  });
}

async function executeContentScript(tabId: number): Promise<void> {
  await removeLegacyContentScripts();

  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["contentScript.js"]
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      }
    );
  });
}

function openOptionsPage(): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.openOptionsPage(() => resolve());
  });
}

function hasStaticContentScriptInManifest(): boolean {
  return Boolean(chrome.runtime.getManifest().content_scripts?.length);
}

async function ensureContentScriptRegistration(): Promise<void> {
  if (hasStaticContentScriptInManifest()) {
    return;
  }

  const hasAllSites = await containsOrigins(["<all_urls>"]);
  const registered = await getRegisteredContentScripts([DYNAMIC_CONTENT_SCRIPT_ID]);
  const isRegistered = registered.some((script) => script.id === DYNAMIC_CONTENT_SCRIPT_ID);

  if (hasAllSites && !isRegistered) {
    await registerContentScripts([
      {
        id: DYNAMIC_CONTENT_SCRIPT_ID,
        js: ["contentScript.js"],
        matches: ["<all_urls>"],
        runAt: "document_idle",
        persistAcrossSessions: true
      }
    ]);
    const tabs = await queryTabs();
    for (const tab of tabs) {
      if (tab.id && tab.url && /^https?:/i.test(tab.url)) {
        try {
          await executeContentScript(tab.id);
        } catch (error) {
          console.debug(`[SubView] Could not inject into tab ${tab.id}`, error);
        }
      }
    }
    return;
  }

  if (!hasAllSites && isRegistered) {
    await unregisterContentScripts([DYNAMIC_CONTENT_SCRIPT_ID]);
  }
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  const hasAllSites = await containsOrigins(["<all_urls>"]);
  if (hasAllSites) {
    return true;
  }

  try {
    const url = new URL(origin);
    const pattern = `${url.protocol}//${url.host}/*`;
    return await containsOrigins([pattern]);
  } catch {
    return false;
  }
}

async function initializeExtension(): Promise<void> {
  await runMigrations();
  await ensureBaseDarkpatternsLoaded();
  await pruneNotificationMap();
  await ensureContentScriptRegistration();
  await rehydrateReminderAlarms();
}

async function buildRuntimeState(origin: string): Promise<RuntimeState> {
  const [settings, hasAllSitesPermission, hostAllowedForCurrentOrigin] = await Promise.all([
    getSettings(),
    containsOrigins(["<all_urls>"]),
    hasOriginPermission(origin)
  ]);

  return {
    settings,
    hasAllSitesPermission,
    hostAllowedForCurrentOrigin
  };
}

function sendTabMessage(tabId: number, message: Message): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => resolve());
  });
}

async function handleMessage(message: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "SPA_NAVIGATED": {
      return { ignored: true };
    }

    case "GET_SETTINGS": {
      return getSettings();
    }

    case "GET_RUNTIME_STATE": {
      return buildRuntimeState(message.payload.origin);
    }

    case "GET_REMINDERS": {
      return getReminders();
    }

    case "GET_DETECTIONS_RECENT": {
      return getDetectionsRecent();
    }

    case "GET_PENDING_DETECTION": {
      const tabId = sender.tab?.id;
      if (!tabId) {
        return null;
      }
      return consumePendingDetectionForTab(tabId);
    }

    case "GET_SITE_POLICY": {
      return getSitePolicy(message.payload.domainKey);
    }

    case "UPSERT_SETTINGS": {
      return upsertSettings(message.payload);
    }

    case "UPSERT_REMINDER": {
      const devFastTrack = chrome.runtime.getManifest().name.includes("(Dev)");
      return upsertReminderFromDetection({
        ...message.payload,
        devFastTrack
      });
    }

    case "UPSERT_SITE_POLICY_OVERRIDE": {
      await upsertUserPolicyOverride(message.payload.domainKey, message.payload.policy);
      return { success: true };
    }

    case "UPSERT_REPORT": {
      const report: UserReport = {
        id: uid("report"),
        ts: new Date().toISOString(),
        ...message.payload.report
      };
      await appendReport(report);
      return { success: true };
    }

    case "UPSERT_DETECTION_EVENT": {
      return appendDetectionEvent(message.payload.event);
    }

    case "SET_PENDING_DETECTION": {
      const tabId = sender.tab?.id;
      if (!tabId) {
        throw new Error("SET_PENDING_DETECTION requires sender tab context");
      }
      await setPendingDetectionForTab(tabId, message.payload.detection);
      return { success: true };
    }

    case "REQUEST_HOST_PERMISSIONS": {
      const granted = await requestOrigins(["<all_urls>"]);
      await ensureContentScriptRegistration();
      return { granted };
    }

    case "EXPORT_ICS": {
      const reminder = await getReminderById(message.payload.reminderId);
      if (!reminder) {
        throw new Error("Reminder not found");
      }
      await exportReminderAsIcs(reminder);
      return { success: true };
    }

    case "EXPORT_LOCAL_DATA": {
      return exportLocalData();
    }

    case "IMPORT_LOCAL_DATA": {
      await importLocalData(message.payload.data);
      await ensureContentScriptRegistration();
      await rehydrateReminderAlarms();
      return { success: true };
    }

    default: {
      const exhaustiveCheck: never = message;
      throw new Error(`Unsupported message: ${(exhaustiveCheck as { type: string }).type}`);
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await initializeExtension();
    if (details.reason === "install" || details.reason === "update") {
      const settings = await getSettings();
      if (settings.requestAllSitesOnStartup) {
        await openOptionsPage();
      }
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});

chrome.permissions.onAdded.addListener(() => {
  void ensureContentScriptRegistration();
});

chrome.permissions.onRemoved.addListener(() => {
  void ensureContentScriptRegistration();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleReminderAlarm(alarm.name);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  void handleNotificationClicked(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  void handleNotificationButtonClicked(notificationId, buttonIndex);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }

  void sendTabMessage(tabId, {
    type: "SPA_NAVIGATED",
    payload: { url: changeInfo.url }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearPendingDetectionForTab(tabId);
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((data) => {
      const response: MessageResponse = { ok: true, data };
      sendResponse(response);
    })
    .catch((error) => {
      const response: MessageResponse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      sendResponse(response);
    });

  return true;
});

// Keep this helper near the background router for future per-tab or tab-origin policy rules.
export function deriveDomainKeyFromUrl(url: string): { hostname: string; domainKey: string } {
  const hostname = getHostname(url);
  const domainKey = getDomainKey(hostname);
  return { hostname, domainKey };
}
