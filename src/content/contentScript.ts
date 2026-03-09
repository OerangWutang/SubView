import { DETECTION_CONFIDENCE_THRESHOLD } from "../shared/constants";
import { getDomainKey, getHostname } from "../shared/domain";
import { sendMessage } from "../shared/messaging";
import type {
  DetectionEvent,
  DetectionResult,
  Message,
  ReminderRecord,
  RuntimeState,
  SitePolicy,
  UserSettings
} from "../shared/types";
import { uid } from "../shared/utils";
import { evaluateCheckoutContext } from "./contextHeuristics";
import { detectSubscriptionContext, type TextCandidate } from "./detector";
import { CommitInterceptor } from "./interceptor";
import { findManageCandidates, buildHelpSearchUrl, type ManageCandidate } from "./linkFinder";
import { IncrementalTextObserver } from "./observer";
import { SubViewOverlay } from "./overlay";

async function run(): Promise<void> {
  const hostname = getHostname(location.href);
  if (!hostname) {
    return;
  }

  const domainKey = getDomainKey(hostname);
  const runtimeState = await sendMessage<RuntimeState>({
    type: "GET_RUNTIME_STATE",
    payload: { origin: location.origin }
  });

  let settings: UserSettings = runtimeState.settings;
  const overlay = new SubViewOverlay();
  overlay.setDebugEnabled(settings.debugOverlay);

  if (!runtimeState.hostAllowedForCurrentOrigin) {
    overlay.updateDebugHud(null, "host permission missing");
    return;
  }

  if (!settings.enabled) {
    overlay.updateDebugHud(null, "extension disabled");
    return;
  }

  if ((settings.disabledDomainKeys || []).includes(domainKey)) {
    overlay.updateDebugHud(null, "domain disabled");
    return;
  }

  let sitePolicy = await sendMessage<SitePolicy | null>({
    type: "GET_SITE_POLICY",
    payload: { domainKey }
  });

  const rollingCandidates: TextCandidate[] = [];
  let lastDetectionSignature = "";
  let lastDetectionSentAt = 0;
  let interceptSnoozeUntil = 0;

  const interceptor = new CommitInterceptor((detection) => {
    void sendMessage({
      type: "SET_PENDING_DETECTION",
      payload: { detection }
    }).catch(() => undefined);
    void openInterceptionModal(detection);
  }, settings.keywordOverrides);

  const resetDetectionState = (): void => {
    rollingCandidates.length = 0;
    lastDetectionSignature = "";
    lastDetectionSentAt = 0;
    interceptSnoozeUntil = 0;
    interceptor.disarm();
    interceptor.clearBlockedFormSubmission();
    observer.forceScan(document.body);
  };

  const observer = new IncrementalTextObserver((incomingCandidates) => {
    rollingCandidates.push(...incomingCandidates);
    if (rollingCandidates.length > 220) {
      rollingCandidates.splice(0, rollingCandidates.length - 220);
    }

    const detection = detectSubscriptionContext({
      candidates: rollingCandidates,
      url: location.href,
      contextLoader: () => evaluateCheckoutContext(location.href, settings.keywordOverrides),
      overrides: settings.keywordOverrides
    });

    if (!detection) {
      overlay.updateDebugHud(null, "ctx lazy");
      interceptor.disarm();
      return;
    }

    overlay.updateDebugHud(detection, "ctx loaded");

    const signature = [
      detection.kind,
      detection.trialDays ?? "-",
      detection.priceAfterTrial ?? "-",
      Math.round(detection.confidence * 100),
      detection.detectedAtUrl
    ].join("|");

    const now = Date.now();
    if (signature !== lastDetectionSignature || now - lastDetectionSentAt > 30_000) {
      lastDetectionSignature = signature;
      lastDetectionSentAt = now;
      const event: DetectionEvent = {
        id: uid("det"),
        hostname,
        domainKey,
        confidence: detection.confidence,
        kind: detection.kind,
        detectedAtUrl: detection.detectedAtUrl,
        ts: new Date().toISOString()
      };
      void sendMessage({ type: "UPSERT_DETECTION_EVENT", payload: { event } }).catch(() => undefined);
    }

    if (detection.confidence >= DETECTION_CONFIDENCE_THRESHOLD && Date.now() >= interceptSnoozeUntil) {
      interceptor.arm(detection);
    } else {
      interceptor.disarm();
    }
  });

  interceptor.start();
  observer.start();
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.type !== "SPA_NAVIGATED") {
      return;
    }
    resetDetectionState();
  });

  const pending = await sendMessage<DetectionResult | null>({ type: "GET_PENDING_DETECTION" });
  if (pending && pending.confidence >= DETECTION_CONFIDENCE_THRESHOLD) {
    await openInterceptionModal(pending);
  }

  async function openInterceptionModal(detection: DetectionResult): Promise<void> {
    const defaultBufferDays = settings.defaultBufferDays;

    overlay.showModal({
      detection,
      domainKey,
      sitePolicy,
      defaultBufferDays,
      callbacks: {
        onAddReminder: async (bufferDays, manageUrl) => {
          const result = await sendMessage<{ reminder: ReminderRecord; duplicateCandidateId?: string }>({
            type: "UPSERT_REMINDER",
            payload: {
              detection,
              hostname,
              domainKey,
              bufferDays,
              manageUrl,
              dedupeAction: "keep-both"
            }
          });

          return {
            reminderId: result.reminder.id,
            duplicateCandidateId: result.duplicateCandidateId
          };
        },
        onFindManageLinks: async () => {
          const localCandidates = findManageCandidates();
          const result: ManageCandidate[] = [];

          if (sitePolicy?.manageUrl) {
            result.push({ url: sitePolicy.manageUrl, label: "Known manage URL", score: 10 });
          }

          result.push(...localCandidates);

          if (result.length === 0) {
            result.push({
              url: buildHelpSearchUrl(domainKey),
              label: "Search cancel help",
              score: 1
            });
          }

          return result;
        },
        onDisableSite: async () => {
          const disabled = Array.from(new Set([...(settings.disabledDomainKeys || []), domainKey]));
          settings = await sendMessage<UserSettings>({
            type: "UPSERT_SETTINGS",
            payload: { disabledDomainKeys: disabled }
          });
          interceptor.disarm();
          observer.stop();
        },
        onDismiss: (reason) => {
          if (reason === "continue") {
            const resumed = interceptor.continueBlockedFormSubmission();
            if (!resumed) {
              alert("SubView: Could not automatically resume checkout. Please click the checkout button again.");
            }
          } else {
            interceptor.clearBlockedFormSubmission();
          }

          if (reason === "dismiss" || reason === "site-disabled") {
            interceptSnoozeUntil = Date.now() + 5 * 60 * 1000;
            interceptor.disarm();
          }
        },
        onExportIcs: async (reminderId) => {
          await sendMessage({
            type: "EXPORT_ICS",
            payload: { reminderId }
          });
        }
      }
    });
  }
}

void run().catch((error) => {
  // Fail silently in-page to avoid checkout disruption.
  console.error("SubView content script failed", error);
});
