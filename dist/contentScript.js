"use strict";
(() => {
  // src/shared/constants.ts
  var DETECTION_CONFIDENCE_THRESHOLD = 0.7;
  var INTERCEPT_IDLE_MS = 5 * 60 * 1e3;
  var NOTIFICATION_MAP_TTL_MS = 24 * 60 * 60 * 1e3;
  var MODAL_BUFFER_MIN = 0;
  var MODAL_BUFFER_MAX = 7;
  var SCAN_DEBOUNCE_MS = 500;
  var SCAN_TEXT_CHAR_LIMIT = 3e4;
  var SCAN_MAX_SNIPPETS = 120;

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
  function getHostname(url) {
    try {
      return cleanHostname(new URL(url).hostname);
    } catch {
      return "";
    }
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
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function uid(prefix = "tg") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function addDays(base, days) {
    const next = new Date(base);
    next.setDate(next.getDate() + days);
    return next;
  }

  // src/content/contextHeuristics.ts
  var BASE_PAYMENT_TERMS = [
    "card number",
    "cvv",
    "cvc",
    "billing",
    "payment",
    "expiry",
    "expiration",
    "postal code"
  ];
  var BASE_COMMIT_TERMS = [
    "start trial",
    "subscribe",
    "pay",
    "place order",
    "confirm",
    "complete",
    "complete purchase"
  ];
  function includesAny(text, terms) {
    return terms.some((term) => text.includes(term));
  }
  function normalizeText(value) {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
  }
  function getCommitTerms(overrides) {
    return [...BASE_COMMIT_TERMS, ...overrides?.commit ?? []].map((value) => normalizeText(value));
  }
  function evaluateCheckoutContext(url, overrides) {
    let score = 0;
    const evidence = [];
    const path = (() => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (/(checkout|pay|billing|subscribe|trial)/i.test(path)) {
      score += 0.3;
      evidence.push("context:url_path_hint");
    }
    const commitTerms = getCommitTerms(overrides);
    const paymentTerms = BASE_PAYMENT_TERMS;
    const inputCandidates = Array.from(document.querySelectorAll("input, textarea, select"));
    for (const element of inputCandidates) {
      const parts = [
        element.getAttribute("name") ?? "",
        element.getAttribute("id") ?? "",
        element.getAttribute("placeholder") ?? "",
        element.getAttribute("autocomplete") ?? "",
        element.getAttribute("aria-label") ?? ""
      ];
      const text = normalizeText(parts.join(" "));
      if (includesAny(text, paymentTerms) || /cc-number|cardnumber|cc-csc|cc-exp/i.test(text)) {
        score += 0.35;
        evidence.push("context:payment_fields");
        break;
      }
    }
    const commitElements = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button'], a"));
    for (const element of commitElements) {
      const parts = [
        element.textContent ?? "",
        element.getAttribute("value") ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("data-testid") ?? "",
        element.getAttribute("name") ?? ""
      ];
      const text = normalizeText(parts.join(" "));
      if (includesAny(text, commitTerms)) {
        score += 0.35;
        evidence.push("context:commit_button");
        break;
      }
    }
    return {
      score: Math.min(1, score),
      evidence
    };
  }
  function textFromElement(element) {
    const values = [
      element.textContent ?? "",
      element.getAttribute("value") ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("data-testid") ?? "",
      element.getAttribute("name") ?? "",
      element.getAttribute("id") ?? ""
    ];
    return normalizeText(values.join(" "));
  }
  function formHasPaymentHints(form) {
    const fields = form.querySelectorAll("input, select, textarea");
    for (const field of fields) {
      const text = textFromElement(field);
      if (includesAny(text, BASE_PAYMENT_TERMS) || /cc-number|cardnumber|cc-csc|cc-exp/i.test(text)) {
        return true;
      }
    }
    return false;
  }
  function isLikelyCommitTarget(target, overrides) {
    if (!(target instanceof Element)) {
      return false;
    }
    const commitTerms = getCommitTerms(overrides);
    const clickable = target.closest("button, input[type='submit'], [role='button'], a");
    if (clickable) {
      const text = textFromElement(clickable);
      if (includesAny(text, commitTerms)) {
        return true;
      }
    }
    const form = target.closest("form");
    if (form instanceof HTMLFormElement && formHasPaymentHints(form)) {
      return true;
    }
    return false;
  }

  // src/content/detector.ts
  var BASE_TRIAL_REGEX = [
    /free\s+trial/i,
    /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|thirty)\s*(day|days|week|weeks|month|months)\s*(free)?/i,
    /start\s+trial/i,
    /trial\s+ends?\s+on/i
  ];
  var BASE_RENEWAL_REGEX = [
    /renew(s|al)?\s+(at|on)/i,
    /then\s+([$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s*\d/i,
    /(billed|charged)\s+(monthly|annually|per\s+month|per\s+year)/i
  ];
  var BASE_SUBSCRIPTION_REGEX = [
    /subscribe|subscription|membership/i,
    /(cancel|manage)\s+(subscription|membership|plan)/i
  ];
  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function keywordRegexes(values) {
    return values.filter(Boolean).map((value) => new RegExp(escapeRegex(value), "i"));
  }
  function isCandidateVisible(element) {
    if (!element) {
      return true;
    }
    if (element.getClientRects().length === 0) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return true;
  }
  function pickSnippet(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  var NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    fourteen: 14,
    twenty: 20,
    thirty: 30
  };
  function extractTrialDays(text) {
    const match = text.match(
      /((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|thirty))\s*(day|days|week|weeks|month|months)/i
    );
    if (!match) {
      return null;
    }
    const rawValue = match[1].toLowerCase();
    const value = /^\d+$/.test(rawValue) ? Number(rawValue) : NUMBER_WORDS[rawValue];
    const unit = match[2].toLowerCase();
    if (Number.isNaN(value) || value <= 0 || value === void 0) {
      return null;
    }
    if (unit.startsWith("week")) {
      return { days: value * 7, evidence: `normalized:${value}week=7day` };
    }
    if (unit.startsWith("month")) {
      return { days: value * 30, evidence: `normalized:${value}month=30day` };
    }
    return { days: value };
  }
  function extractPriceAfterTrial(text) {
    const match = text.match(
      /(?:then|renew(?:s|al)?(?:\s+at|\s+on)?|billed|charged)[^$€£¥₹\d]{0,20}((?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s?\d+(?:[.,]\d{1,2})?(?:\s*\/?\s*(?:month|year|week|mo|yr))?)/i
    );
    return match?.[1]?.replace(/\s+/g, " ").trim();
  }
  function extractRenewalPeriod(text) {
    const match = text.match(/(monthly|annually|per\s+month|per\s+year|per\s+week)/i);
    if (!match) {
      return void 0;
    }
    const value = match[1].toLowerCase();
    if (value.includes("week")) {
      return "week";
    }
    if (value.includes("month")) {
      return "month";
    }
    if (value.includes("year") || value.includes("annual")) {
      return "year";
    }
    return value;
  }
  function detectSubscriptionContext(args) {
    const trialRegexes = [...BASE_TRIAL_REGEX, ...keywordRegexes(args.overrides?.trial ?? [])];
    const renewalRegexes = [...BASE_RENEWAL_REGEX, ...keywordRegexes(args.overrides?.renewal ?? [])];
    const subscriptionRegexes = [...BASE_SUBSCRIPTION_REGEX, ...keywordRegexes(args.overrides?.subscription ?? [])];
    const evidence = /* @__PURE__ */ new Set();
    let trialDays;
    let priceAfterTrial;
    let renewalPeriod;
    let trialHits = 0;
    let renewalHits = 0;
    let subscriptionHits = 0;
    for (const candidate of args.candidates) {
      if (!candidate.text) {
        continue;
      }
      const text = pickSnippet(candidate.text);
      if (!text) {
        continue;
      }
      const trialMatch = trialRegexes.some((regex, idx) => {
        if (!regex.test(text)) {
          return false;
        }
        if (!isCandidateVisible(candidate.element)) {
          return false;
        }
        evidence.add(`trial:regex_${idx}`);
        return true;
      });
      const renewalMatch = renewalRegexes.some((regex, idx) => {
        if (!regex.test(text)) {
          return false;
        }
        if (!isCandidateVisible(candidate.element)) {
          return false;
        }
        evidence.add(`renewal:regex_${idx}`);
        return true;
      });
      const subscriptionMatch = subscriptionRegexes.some((regex, idx) => {
        if (!regex.test(text)) {
          return false;
        }
        if (!isCandidateVisible(candidate.element)) {
          return false;
        }
        evidence.add(`subscription:regex_${idx}`);
        return true;
      });
      if (trialMatch) {
        trialHits += 1;
        if (trialDays === void 0) {
          const extractedTrial = extractTrialDays(text);
          if (extractedTrial) {
            trialDays = extractedTrial.days;
            if (extractedTrial.evidence) {
              evidence.add(extractedTrial.evidence);
            }
          }
        }
      }
      if (renewalMatch) {
        renewalHits += 1;
        if (!priceAfterTrial) {
          priceAfterTrial = extractPriceAfterTrial(text);
        }
        if (!renewalPeriod) {
          renewalPeriod = extractRenewalPeriod(text);
        }
      }
      if (subscriptionMatch) {
        subscriptionHits += 1;
      }
    }
    if (trialHits === 0 && renewalHits === 0 && subscriptionHits === 0) {
      return null;
    }
    const context = args.contextLoader();
    if (context.evidence.length > 0) {
      for (const item of context.evidence) {
        evidence.add(item);
      }
    }
    const kind = trialHits > 0 || trialDays ? "trial" : subscriptionHits > 0 ? "subscription" : "unknown";
    let confidence = 0;
    if (trialHits > 0 || trialDays !== void 0) {
      confidence += 0.35;
    }
    if (renewalHits > 0 || Boolean(priceAfterTrial)) {
      confidence += 0.25;
    }
    if (subscriptionHits > 0) {
      confidence += 0.2;
    }
    confidence += Math.min(0.2, context.score * 0.2);
    confidence = clamp(confidence, 0, 1);
    return {
      confidence,
      kind,
      trialDays,
      priceAfterTrial,
      renewalPeriod,
      evidence: [...evidence],
      detectedAtUrl: args.url
    };
  }

  // src/content/interceptor.ts
  var CommitInterceptor = class {
    constructor(onIntercept, keywordOverrides) {
      this.onIntercept = onIntercept;
      this.keywordOverrides = keywordOverrides;
      this.armedDetection = null;
      this.idleTimer = null;
      this.blockedFormSubmission = null;
      this.blockedClickTarget = null;
      this.blockedClickForm = null;
      this.replayInProgress = false;
      this.onClick = (event) => {
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
            this.blockedClickForm = clickable.closest("form");
          }
        }
        this.trigger(this.armedDetection);
      };
      this.onSubmit = (event) => {
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
        const target = event.target;
        if (target instanceof HTMLFormElement) {
          this.blockedFormSubmission = target;
        }
        this.trigger(this.armedDetection);
      };
    }
    start() {
      document.addEventListener("click", this.onClick, true);
      document.addEventListener("submit", this.onSubmit, true);
    }
    stop() {
      document.removeEventListener("click", this.onClick, true);
      document.removeEventListener("submit", this.onSubmit, true);
      this.disarm();
      this.clearBlockedFormSubmission();
    }
    arm(detection) {
      this.armedDetection = detection;
      this.refreshIdleTimer();
    }
    disarm() {
      this.armedDetection = null;
      if (this.idleTimer !== null) {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    }
    continueBlockedFormSubmission() {
      let resumed = false;
      this.replayInProgress = true;
      try {
        const submitForm = (form) => {
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
        } else if (this.blockedClickTarget && this.blockedClickTarget.isConnected) {
          this.blockedClickTarget.click();
          resumed = true;
        } else if (this.blockedClickForm) {
          resumed = submitForm(this.blockedClickForm);
        }
      } finally {
        this.replayInProgress = false;
      }
      this.clearBlockedFormSubmission();
      return resumed;
    }
    clearBlockedFormSubmission() {
      this.blockedFormSubmission = null;
      this.blockedClickTarget = null;
      this.blockedClickForm = null;
    }
    updateKeywordOverrides(overrides) {
      this.keywordOverrides = overrides;
    }
    refreshIdleTimer() {
      if (this.idleTimer !== null) {
        window.clearTimeout(this.idleTimer);
      }
      this.idleTimer = window.setTimeout(() => {
        this.disarm();
      }, INTERCEPT_IDLE_MS);
    }
    trigger(detection) {
      this.onIntercept(detection);
      this.disarm();
    }
  };

  // src/content/linkFinder.ts
  var KEYWORDS = ["manage", "cancel", "subscription", "billing", "account", "plan"];
  function normalize(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
  }
  function scoreText(text) {
    let score = 0;
    const normalized = normalize(text);
    for (const keyword of KEYWORDS) {
      if (normalized.includes(keyword)) {
        score += keyword === "cancel" || keyword === "manage" ? 3 : 2;
      }
    }
    return score;
  }
  function absoluteUrl(href) {
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  }
  function findManageCandidates() {
    const candidates = [];
    const links = Array.from(document.querySelectorAll("a, button"));
    for (const element of links) {
      const text = [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("data-testid") ?? ""
      ].join(" ");
      const textScore = scoreText(text);
      if (textScore <= 0) {
        continue;
      }
      const href = element instanceof HTMLAnchorElement ? element.href : element.getAttribute("data-href") ?? element.getAttribute("href") ?? "";
      const url = href ? absoluteUrl(href) : null;
      if (!url) {
        continue;
      }
      candidates.push({
        url,
        label: normalize(text).slice(0, 80) || "Manage link",
        score: textScore
      });
    }
    const commonPaths = ["/account", "/settings", "/billing", "/subscriptions"];
    for (const path of commonPaths) {
      candidates.push({
        url: `${location.origin}${path}`,
        label: path,
        score: 1
      });
    }
    const deduped = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      const existing = deduped.get(candidate.url);
      if (!existing || existing.score < candidate.score) {
        deduped.set(candidate.url, candidate);
      }
    }
    return [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  }
  function buildHelpSearchUrl(domainKey) {
    const query = `"${domainKey}" cancel subscription`;
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  // src/content/observer.ts
  function isIgnoredByAncestry(node) {
    if (!(node instanceof Element) && !(node.parentElement instanceof Element)) {
      return false;
    }
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) {
      return false;
    }
    const blocked = element.closest("script, style, noscript, [hidden], [aria-hidden='true']");
    return Boolean(blocked);
  }
  function normalizeText2(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  function collectTextCandidatesFromNode(node, budget) {
    const output = [];
    const walkerRoot = node instanceof Text ? node.parentNode : node;
    if (!walkerRoot) {
      return output;
    }
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
    let current = walker.currentNode;
    while (current) {
      if (budget.snippets >= SCAN_MAX_SNIPPETS || budget.chars >= SCAN_TEXT_CHAR_LIMIT) {
        break;
      }
      if (current instanceof Text) {
        const parent = current.parentElement;
        if (!isIgnoredByAncestry(current) && parent) {
          const text = normalizeText2(current.textContent ?? "");
          if (text.length > 0) {
            const clipped = text.slice(0, 300);
            budget.snippets += 1;
            budget.chars += clipped.length;
            output.push({ text: clipped, element: parent });
          }
        }
      }
      current = walker.nextNode();
    }
    return output;
  }
  var IncrementalTextObserver = class {
    constructor(onCandidates) {
      this.onCandidates = onCandidates;
      this.observer = null;
      this.queue = /* @__PURE__ */ new Set();
      this.timer = null;
    }
    start() {
      if (!document.body || this.observer) {
        return;
      }
      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.target) {
            this.queue.add(mutation.target);
          }
          mutation.addedNodes.forEach((node) => {
            this.queue.add(node);
          });
        }
        this.schedule();
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      this.forceScan(document.body);
    }
    stop() {
      this.observer?.disconnect();
      this.observer = null;
      this.queue.clear();
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    }
    forceScan(root = document.body) {
      if (!root) {
        return;
      }
      this.queue.clear();
      this.queue.add(root);
      this.flushQueue();
    }
    schedule() {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
      }
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.flushQueue();
      }, SCAN_DEBOUNCE_MS);
    }
    flushQueue() {
      if (this.queue.size === 0) {
        return;
      }
      const start = performance.now();
      const budget = { chars: 0, snippets: 0 };
      const candidates = [];
      const rootNodes = /* @__PURE__ */ new Set();
      for (const node of this.queue) {
        let isRedundant = false;
        let parent = node.parentNode;
        while (parent) {
          if (this.queue.has(parent)) {
            isRedundant = true;
            break;
          }
          parent = parent.parentNode;
        }
        if (!isRedundant) {
          rootNodes.add(node);
        }
      }
      for (const node of rootNodes) {
        if (budget.snippets >= SCAN_MAX_SNIPPETS || budget.chars >= SCAN_TEXT_CHAR_LIMIT) {
          break;
        }
        const chunk = collectTextCandidatesFromNode(node, budget);
        candidates.push(...chunk);
      }
      this.queue.clear();
      const elapsed = performance.now() - start;
      if (elapsed > 40) {
        console.debug(
          `[TrialGuard] Heavy DOM scan: ${elapsed.toFixed(1)}ms for ${candidates.length} snippets (roots: ${rootNodes.size})`
        );
      }
      if (candidates.length > 0) {
        this.onCandidates(candidates);
      }
    }
  };

  // src/content/overlay.ts
  var TrialGuardOverlay = class {
    constructor() {
      this.activeCallbacks = null;
      this.lastFocused = null;
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
      input[type='number'] { width: 64px; padding: 4px 6px; }
    `;
      this.hud = document.createElement("div");
      this.hud.className = "tg-hud";
      this.modalRoot = document.createElement("div");
      this.modalRoot.className = "tg-modal-backdrop";
      this.shadow.append(this.styleEl, this.hud, this.modalRoot);
      document.documentElement.appendChild(this.host);
    }
    setDebugEnabled(enabled) {
      this.hud.style.display = enabled ? "block" : "none";
    }
    updateDebugHud(detection, note) {
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
    hideModal(reason = "dismiss") {
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
    showModal(params) {
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
      bufferLabel.textContent = "Buffer days";
      bufferLabel.htmlFor = "tg-buffer";
      const bufferInput = document.createElement("input");
      bufferInput.id = "tg-buffer";
      bufferInput.type = "number";
      bufferInput.min = String(MODAL_BUFFER_MIN);
      bufferInput.max = String(MODAL_BUFFER_MAX);
      bufferInput.value = String(clamp(params.defaultBufferDays, MODAL_BUFFER_MIN, MODAL_BUFFER_MAX));
      bufferRow.append(bufferLabel, bufferInput);
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
      let selectedManageUrl = policy?.manageUrl;
      let createdReminderId = null;
      const updateReminderDateText = () => {
        const bufferDays = clamp(Number(bufferInput.value), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
        const daysUntilCancel = Math.max(0, trialDays - bufferDays);
        const date = addDays(/* @__PURE__ */ new Date(), daysUntilCancel);
        date.setHours(9, 0, 0, 0);
        dateText.textContent = `Suggested cancel reminder date: ${date.toLocaleString()}`;
      };
      updateReminderDateText();
      bufferInput.addEventListener("change", updateReminderDateText);
      addReminderButton.addEventListener("click", async () => {
        const bufferDays = clamp(Number(bufferInput.value), MODAL_BUFFER_MIN, MODAL_BUFFER_MAX);
        const result = await params.callbacks.onAddReminder(bufferDays, selectedManageUrl);
        createdReminderId = result.reminderId;
        exportIcsButton.disabled = false;
        status.textContent = result.duplicateCandidateId ? "Reminder saved. Similar reminder detected and linked." : "Reminder saved.";
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
      const onKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          this.hideModal("dismiss");
        }
        if (event.key === "Tab") {
          const focusables = Array.from(
            backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")
          ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
          if (focusables.length === 0) {
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = this.shadow.activeElement ?? document.activeElement;
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
      body.append(summary, dateText, bufferRow);
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
    destroy() {
      this.host.remove();
    }
  };

  // src/content/contentScript.ts
  async function run() {
    const hostname = getHostname(location.href);
    if (!hostname) {
      return;
    }
    const domainKey = getDomainKey(hostname);
    const runtimeState = await sendMessage({
      type: "GET_RUNTIME_STATE",
      payload: { origin: location.origin }
    });
    let settings = runtimeState.settings;
    const overlay = new TrialGuardOverlay();
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
    let sitePolicy = await sendMessage({
      type: "GET_SITE_POLICY",
      payload: { domainKey }
    });
    const rollingCandidates = [];
    let lastDetectionSignature = "";
    let lastDetectionSentAt = 0;
    let interceptSnoozeUntil = 0;
    const interceptor = new CommitInterceptor((detection) => {
      void sendMessage({
        type: "SET_PENDING_DETECTION",
        payload: { detection }
      }).catch(() => void 0);
      void openInterceptionModal(detection);
    }, settings.keywordOverrides);
    const resetDetectionState = () => {
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
      if (signature !== lastDetectionSignature || now - lastDetectionSentAt > 3e4) {
        lastDetectionSignature = signature;
        lastDetectionSentAt = now;
        const event = {
          id: uid("det"),
          hostname,
          domainKey,
          confidence: detection.confidence,
          kind: detection.kind,
          detectedAtUrl: detection.detectedAtUrl,
          ts: (/* @__PURE__ */ new Date()).toISOString()
        };
        void sendMessage({ type: "UPSERT_DETECTION_EVENT", payload: { event } }).catch(() => void 0);
      }
      if (detection.confidence >= DETECTION_CONFIDENCE_THRESHOLD && Date.now() >= interceptSnoozeUntil) {
        interceptor.arm(detection);
      } else {
        interceptor.disarm();
      }
    });
    interceptor.start();
    observer.start();
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type !== "SPA_NAVIGATED") {
        return;
      }
      resetDetectionState();
    });
    const pending = await sendMessage({ type: "GET_PENDING_DETECTION" });
    if (pending && pending.confidence >= DETECTION_CONFIDENCE_THRESHOLD) {
      await openInterceptionModal(pending);
    }
    async function openInterceptionModal(detection) {
      const defaultBufferDays = settings.defaultBufferDays;
      overlay.showModal({
        detection,
        domainKey,
        sitePolicy,
        defaultBufferDays,
        callbacks: {
          onAddReminder: async (bufferDays, manageUrl) => {
            const result = await sendMessage({
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
            const result = [];
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
            const disabled = Array.from(/* @__PURE__ */ new Set([...settings.disabledDomainKeys || [], domainKey]));
            settings = await sendMessage({
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
                alert("TrialGuard: Could not automatically resume checkout. Please click the checkout button again.");
              }
            } else {
              interceptor.clearBlockedFormSubmission();
            }
            if (reason === "dismiss" || reason === "site-disabled") {
              interceptSnoozeUntil = Date.now() + 5 * 60 * 1e3;
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
    console.error("TrialGuard content script failed", error);
  });
})();
//# sourceMappingURL=contentScript.js.map
