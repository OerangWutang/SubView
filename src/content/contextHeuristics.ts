import type { KeywordOverrides } from "../shared/types";

const BASE_PAYMENT_TERMS = [
  "card number",
  "cvv",
  "cvc",
  "billing",
  "payment",
  "expiry",
  "expiration",
  "postal code"
];

const BASE_COMMIT_TERMS = [
  "start trial",
  "subscribe",
  "pay",
  "place order",
  "confirm",
  "complete",
  "complete purchase"
];

export type CheckoutContextResult = {
  score: number;
  evidence: string[];
};

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function getCommitTerms(overrides?: KeywordOverrides): string[] {
  return [...BASE_COMMIT_TERMS, ...(overrides?.commit ?? [])].map((value) => normalizeText(value));
}

export function evaluateCheckoutContext(url: string, overrides?: KeywordOverrides): CheckoutContextResult {
  let score = 0;
  const evidence: string[] = [];

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

function textFromElement(element: Element): string {
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

function formHasPaymentHints(form: HTMLFormElement): boolean {
  const fields = Array.from(form.querySelectorAll("input, select, textarea"));
  for (const field of fields) {
    const text = textFromElement(field);
    if (includesAny(text, BASE_PAYMENT_TERMS) || /cc-number|cardnumber|cc-csc|cc-exp/i.test(text)) {
      return true;
    }
  }
  return false;
}

export function isLikelyCommitTarget(target: EventTarget | null, overrides?: KeywordOverrides): boolean {
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
