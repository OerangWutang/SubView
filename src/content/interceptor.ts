import { INTERCEPT_IDLE_MS } from "../shared/constants";
import type { DetectionResult, KeywordOverrides } from "../shared/types";
import { isLikelyCommitTarget } from "./contextHeuristics";

export class CommitInterceptor {
  private armedDetection: DetectionResult | null = null;
  private idleTimer: number | null = null;
  private blockedFormSubmission: HTMLFormElement | null = null;
  private blockedClickTarget: HTMLElement | null = null;
  private blockedClickForm: HTMLFormElement | null = null;
  private blockedFallbackSelector: string | null = null;
  private replayInProgress = false;

  constructor(
    private readonly onIntercept: (detection: DetectionResult) => void,
    private keywordOverrides?: KeywordOverrides
  ) {}

  private onClick = (event: MouseEvent): void => {
    if (this.replayInProgress) {
      return;
    }

    if (!this.armedDetection) {
      return;
    }

    if (!isLikelyCommitTarget(event.target, this.keywordOverrides)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.target instanceof Element) {
      const clickable = event.target.closest("button, input[type='submit'], [role='button'], a");
      if (clickable instanceof HTMLElement) {
        this.blockedClickTarget = clickable;
        // Safe escape helper that survives environments lacking CSS.escape
        const safeEscape = (val: string): string => {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(val);
          }

          // Fallback implementation based on the CSSOM specification for CSS.escape
          const string = String(val);
          const length = string.length;
          let result = "";

          for (let index = 0; index < length; index++) {
            const codeUnit = string.charCodeAt(index);

            // Replace null characters
            if (codeUnit === 0x0000) {
              result += "\uFFFD";
              continue;
            }

            // Control characters, DEL, or certain leading digits
            if (
              (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
              codeUnit === 0x007f ||
              (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
              (index === 1 &&
                codeUnit >= 0x0030 &&
                codeUnit <= 0x0039 &&
                string.charCodeAt(0) === 0x002d)
            ) {
              result += "\\" + codeUnit.toString(16) + " ";
              continue;
            }

            // Escape a lone '-' if it's the only character
            if (index === 0 && codeUnit === 0x002d && length === 1) {
              result += "\\" + string.charAt(index);
              continue;
            }

            // Safe characters: letters, digits, '-', '_', non-ASCII
            if (
              codeUnit >= 0x0080 ||
              codeUnit === 0x002d ||
              codeUnit === 0x005f ||
              (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
              (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
              (codeUnit >= 0x0061 && codeUnit <= 0x007a)
            ) {
              result += string.charAt(index);
              continue;
            }

            // Everything else gets a simple escape
            result += "\\" + string.charAt(index);
          }

          return result;
        };
        const rawId = clickable.id;
        const id = rawId ? `#${safeEscape(rawId)}` : "";
        const rawTestId = clickable.getAttribute("data-testid");
        const testId = rawTestId ? `[data-testid='${safeEscape(rawTestId)}']` : "";
        this.blockedFallbackSelector = id || testId || null;
        this.blockedClickForm = clickable.closest("form");
      }
    }

    this.trigger(this.armedDetection);
  };

  private onSubmit = (event: SubmitEvent): void => {
    if (this.replayInProgress) {
      return;
    }

    if (!this.armedDetection) {
      return;
    }

    const checkTarget = event.submitter ?? event.target;
    if (!isLikelyCommitTarget(checkTarget, this.keywordOverrides)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const target = event.target;
    if (target instanceof HTMLFormElement) {
      this.blockedFormSubmission = target;
    }

    this.trigger(this.armedDetection);
  };

  start(): void {
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("submit", this.onSubmit, true);
  }

  stop(): void {
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("submit", this.onSubmit, true);
    this.disarm();
    this.clearBlockedFormSubmission();
  }

  arm(detection: DetectionResult): void {
    this.armedDetection = detection;
    this.refreshIdleTimer();
  }

  disarm(): void {
    this.armedDetection = null;
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  continueBlockedFormSubmission(): boolean {
    let resumed = false;

    this.replayInProgress = true;
    try {
      const submitForm = (form: HTMLFormElement): boolean => {
        if (!form.isConnected) {
          return false;
        }
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          HTMLFormElement.prototype.submit.call(form);
        }
        return true;
      };

      if (this.blockedFormSubmission) {
        resumed = submitForm(this.blockedFormSubmission);
      } else {
        let clickTarget: HTMLElement | null = null;
        if (this.blockedClickTarget?.isConnected) {
          clickTarget = this.blockedClickTarget;
        } else if (this.blockedFallbackSelector) {
          try {
            const found = document.querySelector(this.blockedFallbackSelector);
            if (found instanceof HTMLElement) {
              clickTarget = found;
            }
          } catch {
            // Treat malformed selectors as "not found" and continue with fallbacks.
          }
        }

        if (clickTarget) {
          clickTarget.click();
          resumed = true;
        } else if (this.blockedClickForm) {
          resumed = submitForm(this.blockedClickForm);
        }
      }
    } finally {
      this.replayInProgress = false;
    }

    this.clearBlockedFormSubmission();
    return resumed;
  }

  clearBlockedFormSubmission(): void {
    this.blockedFormSubmission = null;
    this.blockedClickTarget = null;
    this.blockedClickForm = null;
    this.blockedFallbackSelector = null;
  }

  updateKeywordOverrides(overrides?: KeywordOverrides): void {
    this.keywordOverrides = overrides;
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
    }

    this.idleTimer = window.setTimeout(() => {
      this.disarm();
    }, INTERCEPT_IDLE_MS);
  }

  private trigger(detection: DetectionResult): void {
    this.onIntercept(detection);
    this.disarm();
  }
}
