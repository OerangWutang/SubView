import { MODAL_BUFFER_MAX, MODAL_BUFFER_MIN } from "../shared/constants";
import type { BillingCycle, DetectionResult, SitePolicy } from "../shared/types";
import { addDays, clamp } from "../shared/utils";
import type { ManageCandidate } from "./linkFinder";

type ModalCallbacks = {
  onAddReminder: (
    bufferDays: number,
    manageUrl?: string,
    pricePerCycle?: number,
    billingCycle?: BillingCycle,
    renewalDate?: string,
    tosRequiredDays?: number
  ) => Promise<{ reminderId: string; duplicateCandidateId?: string }>;
  onFindManageLinks: () => Promise<ManageCandidate[]>;
  onDisableSite: () => Promise<void>;
  onDismiss: (reason: "continue" | "dismiss" | "site-disabled") => void;
  onExportIcs: (reminderId: string) => Promise<void>;
};

export class TrialGuardOverlay {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly hud: HTMLDivElement;
  private readonly modalRoot: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;

  private activeCallbacks: ModalCallbacks | null = null;
  private lastFocused: Element | null = null;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "trialguard-root";
    this.shadow = this.host.attachShadow({ mode: "open" });

    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      :host { all: initial; }
      .tg-hud {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483646;
        background: #111827;
        color: #f9fafb;
        font: 12px/1.35 ui-sans-serif, system-ui, sans-serif;
        border-radius: 8px;
        padding: 8px 10px;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.25);
        display: none;
        max-width: 280px;
      }
      .tg-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 14px;
      }
      .tg-modal {
        width: min(520px, 94vw);
        background: #ffffff;
        color: #111827;
        border-radius: 12px;
        border: 1px solid #d1d5db;
        box-shadow: 0 20px 50px rgba(0,0,0,0.3);
        font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
      }
      .tg-modal header { padding: 14px 16px; border-bottom: 1px solid #e5e7eb; }
      .tg-modal h2 { margin: 0; font-size: 17px; }
      .tg-body { padding: 14px 16px; display: grid; gap: 10px; }
      .tg-warning {
        padding: 8px 10px;
        border-radius: 8px;
        font-size: 13px;
        border: 1px solid #fca5a5;
        background: #fee2e2;
        color: #7f1d1d;
      }
      .tg-muted { color: #4b5563; font-size: 13px; }
      .tg-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .tg-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .tg-actions button, .tg-row button {
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 7px 10px;
        background: #fff;
        cursor: pointer;
      }
      .tg-actions .tg-primary {
        background: #111827;
        color: #fff;
        border-color: #111827;
      }
      .tg-list { margin: 0; padding-left: 18px; max-height: 120px; overflow: auto; }
      .tg-list a { color: #0f766e; word-break: break-all; }
      .tg-steps { margin: 0; padding-left: 18px; }
      .tg-status { font-size: 12px; color: #065f46; }
      .tg-tos-warning {
        padding: 8px 10px;
        border-radius: 8px;
        font-size: 13px;
        border: 1px solid #fbbf24;
        background: #fffbeb;
        color: #78350f;
      }
      .tg-deadline { font-size: 13px; color: #065f46; font-weight: 600; }
      input[type='number'] { width: 64px; padding: 4px 6px; }
      input[type='date'] { padding: 4px 6px; }
      select { padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }
    `;

    this.hud = document.createElement("div");
    this.hud.className = "tg-hud";

    this.modalRoot = document.createElement("div");
    this.modalRoot.className = "tg-modal-backdrop";

    this.shadow.append(this.styleEl, this.hud, this.modalRoot);
    document.documentElement.appendChild(this.host);
  }

  setDebugEnabled(enabled: boolean): void {
    this.hud.style.display = enabled ? "block" : "none";
  }

  updateDebugHud(detection: DetectionResult | null, note?: string): void {
    if (!detection) {
      this.hud.textContent = note ? `TrialGuard: ${note}` : "TrialGuard: no detection";
      return;
    }

    this.hud.textContent = "";

    const title = document.createElement("strong");
    title.textContent = "TrialGuard";
    this.hud.appendChild(title);

    const lines = [
      `kind: ${detection.kind}`,
      `confidence: ${detection.confidence.toFixed(2)}`,
      `trialDays: ${detection.trialDays ?? "-"}`,
      note ? `note: ${note}` : ""
    ].filter(Boolean);

    for (const line of lines) {
      this.hud.appendChild(document.createElement("br"));
      this.hud.appendChild(document.createTextNode(line));
    }
  }

  hideModal(reason: "continue" | "dismiss" | "site-disabled" = "dismiss"): void {
    this.modalRoot.style.display = "none";
    this.modalRoot.innerHTML = "";
    this.activeCallbacks?.onDismiss(reason);
    this.activeCallbacks = null;

    if (this.lastFocused instanceof HTMLElement && document.contains(this.lastFocused)) {
      this.lastFocused.focus();
    } else {
      document.body.focus();
    }
  }

  showModal(params: {
    detection: DetectionResult;
    domainKey: string;
    sitePolicy: SitePolicy | null;
    defaultBufferDays: number;
    callbacks: ModalCallbacks;
  }): void {
    this.activeCallbacks = params.callbacks;
    this.lastFocused = document.activeElement;

    const trialDays = params.detection.trialDays ?? 30;
    const policy = params.sitePolicy;

    const backdrop = document.createElement("div");
    backdrop.className = "tg-modal";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "tg-title");

    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.id = "tg-title";
    title.textContent = "Trial detected before checkout";
    header.appendChild(title);

    const body = document.createElement("div");
    body.className = "tg-body";

    const summary = document.createElement("div");
    summary.textContent = "Detected ";
    const strong = document.createElement("strong");
    strong.textContent = `${trialDays}-day ${params.detection.kind}`;
    summary.append(strong, document.createTextNode(` context. Confidence ${params.detection.confidence.toFixed(2)}.`));

    const dateText = document.createElement("div");
    dateText.className = "tg-muted";

    const bufferRow = document.createElement("div");
    bufferRow.className = "tg-row";
    const bufferLabel = document.createElement("label");
    bufferLabel.textContent = "Remind me (days before)";
    bufferLabel.htmlFor = "tg-buffer";
    const bufferInput = document.createElement("input");
    bufferInput.id = "tg-buffer";
    bufferInput.type = "number";
    bufferInput.min = String(MODAL_BUFFER_MIN);
    bufferInput.max = String(MODAL_BUFFER_MAX);
    bufferInput.value = String(clamp(params.defaultBufferDays, MODAL_BUFFER_MIN, MODAL_BUFFER_MAX));
    bufferRow.append(bufferLabel, bufferInput);

    // Renewal date row
    const renewalRow = document.createElement("div");
    renewalRow.className = "tg-row";
    const renewalLabel = document.createElement("label");
    renewalLabel.textContent = "Renewal date (optional)";
    renewalLabel.htmlFor = "tg-renewal-date";
    const renewalDateInput = document.createElement("input");
    renewalDateInput.id = "tg-renewal-date";
    renewalDateInput.type = "date";
    renewalRow.append(renewalLabel, renewalDateInput);

    // Price + billing cycle row
    const priceRow = document.createElement("div");
    priceRow.className = "tg-row";
    const priceLabel = document.createElement("label");
    priceLabel.textContent = "Cost (optional)";
    priceLabel.htmlFor = "tg-price";
    const priceInput = document.createElement("input");
    priceInput.id = "tg-price";
    priceInput.type = "number";
    priceInput.min = "0";
    priceInput.step = "0.01";
    priceInput.placeholder = "0.00";
    priceInput.style.width = "80px";
    const cycleSelect = document.createElement("select");
    cycleSelect.id = "tg-billing-cycle";
    const cycleOptions: Array<{ value: string; label: string }> = [
      { value: "monthly", label: "/ month" },
      { value: "yearly", label: "/ year" },
      { value: "weekly", label: "/ week" },
      { value: "custom", label: "custom" }
    ];
    for (const opt of cycleOptions) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      cycleSelect.appendChild(option);
    }
    priceRow.append(priceLabel, priceInput, cycleSelect);

    // ToS required days row
    const tosRow = document.createElement("div");
    tosRow.className = "tg-row";
    const tosLabel = document.createElement("label");
    tosLabel.textContent = "Days notice required by Terms of Service";
    tosLabel.htmlFor = "tg-tos-days";
    const tosInput = document.createElement("input");
    tosInput.id = "tg-tos-days";
    tosInput.type = "number";
    tosInput.min = "0";
    tosInput.style.width = "64px";
    tosInput.placeholder = "0";
    if (policy?.tosRequiredDays) {
      tosInput.value = String(policy.tosRequiredDays);
    }
    tosRow.append(tosLabel, tosInput);

    // ToS deadline display
    const tosDeadlineDisplay = document.createElement("div");
    tosDeadlineDisplay.className = "tg-tos-warning";
    tosDeadlineDisplay.style.display = "none";

    const policyWarning = document.createElement("div");
    if (policy && (policy.difficulty === "hard" || policy.difficulty === "medium")) {
      policyWarning.className = "tg-warning";
      policyWarning.textContent = "This site may be ";
      const difficultyStrong = document.createElement("strong");
      difficultyStrong.textContent = policy.difficulty;
      policyWarning.append(difficultyStrong, document.createTextNode(` to cancel (${policy.method}). `));
      if (policy.notes) {
        policyWarning.append(document.createTextNode(policy.notes));
      }
    }

    const stepsBlock = document.createElement("div");
    if (policy?.steps && policy.steps.length > 0) {
      const stepsTitle = document.createElement("div");
      stepsTitle.textContent = "Known cancel steps:";
      const stepsList = document.createElement("ul");
      stepsList.className = "tg-steps";
      for (const step of policy.steps) {
        const li = document.createElement("li");
        li.textContent = step;
        stepsList.appendChild(li);
      }
      stepsBlock.append(stepsTitle, stepsList);
    }

    const linksContainer = document.createElement("div");
    linksContainer.className = "tg-muted";

    const status = document.createElement("div");
    status.className = "tg-status";

    const actions = document.createElement("div");
    actions.className = "tg-actions";

    const addReminderButton = document.createElement("button");
    addReminderButton.className = "tg-primary";
    addReminderButton.type = "button";
    addReminderButton.textContent = "Add reminder";

    const findLinksButton = document.createElement("button");
    findLinksButton.type = "button";
    findLinksButton.textContent = "Find cancel/manage link";

    const exportIcsButton = document.createElement("button");
    exportIcsButton.type = "button";
    exportIcsButton.textContent = "Download calendar event";
    exportIcsButton.disabled = true;

    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.textContent = "Continue";

    const disableSiteButton = document.createElement("button");
    disableSiteButton.type = "button";
    disableSiteButton.textContent = "Don't show again for this site";

    actions.append(addReminderButton, findLinksButton, exportIcsButton, continueButton, disableSiteButton);

    let selectedManageUrl: string | undefined = policy?.manageUrl;
    let createdReminderId: string | null = null;

    const updateReminderDateText = () => {
      const bufferDays = clamp(Number(bufferInput.value), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
      const renewalVal = renewalDateInput.value;
      let date: Date;

      if (renewalVal) {
        date = addDays(new Date(renewalVal), -bufferDays);
      } else {
        const daysUntilCancel = Math.max(0, trialDays - bufferDays);
        date = addDays(new Date(), daysUntilCancel);
      }
      date.setHours(9, 0, 0, 0);
      dateText.textContent = `Suggested cancel reminder: ${date.toLocaleDateString()}`;

      // Update ToS deadline display
      const tosRequiredDays = Number(tosInput.value);
      if (renewalVal && tosRequiredDays > 0) {
        const tosDeadline = addDays(new Date(renewalVal), -tosRequiredDays);
        tosDeadlineDisplay.style.display = "block";
        tosDeadlineDisplay.textContent = `⚠️ Terms of Service require ${tosRequiredDays} day(s) advance notice before renewal. Last safe cancellation date: ${tosDeadline.toLocaleDateString()}`;
      } else {
        tosDeadlineDisplay.style.display = "none";
      }
    };

    updateReminderDateText();

    bufferInput.addEventListener("change", updateReminderDateText);
    renewalDateInput.addEventListener("change", updateReminderDateText);
    tosInput.addEventListener("change", updateReminderDateText);

    addReminderButton.addEventListener("click", async () => {
      const bufferDays = clamp(Number(bufferInput.value), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
      const priceVal = priceInput.value.trim();
      const pricePerCycle = priceVal !== "" ? parseFloat(priceVal) : undefined;
      const billingCycle = cycleSelect.value as BillingCycle | undefined;
      const renewalDate = renewalDateInput.value || undefined;
      const tosRequiredDaysVal = Number(tosInput.value);
      const tosRequiredDays = tosRequiredDaysVal > 0 ? tosRequiredDaysVal : undefined;

      const result = await params.callbacks.onAddReminder(
        bufferDays,
        selectedManageUrl,
        pricePerCycle,
        billingCycle,
        renewalDate,
        tosRequiredDays
      );
      createdReminderId = result.reminderId;
      exportIcsButton.disabled = false;
      status.textContent = result.duplicateCandidateId
        ? "Reminder saved. Similar reminder detected and linked."
        : "Reminder saved.";
    });

    findLinksButton.addEventListener("click", async () => {
      const links = await params.callbacks.onFindManageLinks();
      linksContainer.innerHTML = "";

      if (links.length === 0) {
        linksContainer.textContent = "No direct links found.";
        return;
      }

      const list = document.createElement("ul");
      list.className = "tg-list";
      for (const link of links) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = link.label || link.url;
        li.appendChild(a);
        list.appendChild(li);
      }
      linksContainer.appendChild(list);
      selectedManageUrl = links[0]?.url ?? selectedManageUrl;
    });

    exportIcsButton.addEventListener("click", async () => {
      if (!createdReminderId) {
        status.textContent = "Add a reminder first.";
        return;
      }
      await params.callbacks.onExportIcs(createdReminderId);
      status.textContent = "ICS download started.";
    });

    continueButton.addEventListener("click", () => this.hideModal("continue"));

    disableSiteButton.addEventListener("click", async () => {
      await params.callbacks.onDisableSite();
      this.hideModal("site-disabled");
    });

    this.modalRoot.onclick = (event) => {
      if (event.target === this.modalRoot) {
        this.hideModal("dismiss");
      }
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideModal("dismiss");
      }

      if (event.key === "Tab") {
        const focusables = Array.from(
          backdrop.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")
        ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);

        if (focusables.length === 0) {
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = (this.shadow.activeElement as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);

        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    this.modalRoot.onkeydown = onKeydown;

    body.append(summary, dateText, bufferRow, renewalRow, priceRow, tosRow, tosDeadlineDisplay);
    if (policyWarning.className) {
      body.append(policyWarning);
    }
    if (stepsBlock.childElementCount > 0) {
      body.append(stepsBlock);
    }
    body.append(linksContainer, actions, status);

    backdrop.append(header, body);

    this.modalRoot.innerHTML = "";
    this.modalRoot.appendChild(backdrop);
    this.modalRoot.style.display = "flex";

    addReminderButton.focus();
  }

  destroy(): void {
    this.host.remove();
  }
}
