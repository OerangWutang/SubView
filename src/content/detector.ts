import type { DetectionResult, KeywordOverrides } from "../shared/types";
import { clamp } from "../shared/utils";
import type { CheckoutContextResult } from "./contextHeuristics";

export type TextCandidate = {
  text: string;
  element?: WeakRef<Element> | null;
};

const BASE_TRIAL_REGEX = [
  /free\s+trial/i,
  /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)\s*(day|days|week|weeks|month|months)\s*(free)?/i,
  /start\s+trial/i,
  /trial\s+ends?\s+on/i
];

const BASE_RENEWAL_REGEX = [
  /renew(s|al)?\s+(at|on)/i,
  /then\s+(?:(?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s*\d|\d[\d.,]*\s*(?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR))/i,
  /(billed|charged)\s+(monthly|annually|yearly|weekly|per\s+month|per\s+year|per\s+week)/i
];

const BASE_SUBSCRIPTION_REGEX = [
  /subscribe|subscription|membership/i,
  /(cancel|manage)\s+(subscription|membership|plan)/i
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordRegexes(values: string[]): RegExp[] {
  return values.filter(Boolean).map((value) => new RegExp(escapeRegex(value), "i"));
}

interface CompiledRegexes {
  overrides: KeywordOverrides | undefined;
  trial: RegExp[];
  renewal: RegExp[];
  subscription: RegExp[];
}

let _compiledRegexCacheKey: string | null = null;
let _compiledRegexCache: CompiledRegexes | null = null;

function getCompiledRegexes(overrides?: KeywordOverrides): CompiledRegexes {
  const cacheKey = JSON.stringify(overrides ?? null);
  if (_compiledRegexCache && _compiledRegexCacheKey === cacheKey) {
    return _compiledRegexCache;
  }
  _compiledRegexCacheKey = cacheKey;
  _compiledRegexCache = {
    overrides,
    trial: [...BASE_TRIAL_REGEX, ...keywordRegexes(overrides?.trial ?? [])],
    renewal: [...BASE_RENEWAL_REGEX, ...keywordRegexes(overrides?.renewal ?? [])],
    subscription: [...BASE_SUBSCRIPTION_REGEX, ...keywordRegexes(overrides?.subscription ?? [])]
  };
  return _compiledRegexCache;
}

function isCandidateVisible(element?: WeakRef<Element> | null): boolean {
  const el = element?.deref();
  if (!el) {
    return true;
  }

  if (el.getClientRects().length === 0) {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }

  if (style.fontSize === "0px" || style.color === "transparent" || style.color === "rgba(0, 0, 0, 0)") {
    return false;
  }

  return true;
}

function pickSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

const NUMBER_WORDS: Record<string, number> = {
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30
};

function extractTrialDays(text: string): { days: number; evidence?: string } | null {
  const match = text.match(
    /((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty))\s*(day|days|week|weeks|month|months)/i
  );
  if (!match) {
    return null;
  }

  const rawValue = match[1].toLowerCase();
  const value = /^\d+$/.test(rawValue) ? Number(rawValue) : NUMBER_WORDS[rawValue];
  const unit = match[2].toLowerCase();

  if (value === undefined || Number.isNaN(value) || value <= 0) {
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

function extractPriceAfterTrial(text: string): string | undefined {
  // Currency-first format: e.g. "then $9.99/month" or "then USD 9.99 per month"
  const currencyFirstMatch = text.match(
    /(?:then|renew(?:s|al)?(?:\s+at|\s+on)?|billed|charged)[^$€£¥₹\d]{0,20}((?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s?\d+(?:[.,]\d{1,2})?(?:\s*(?:per\s+|\/\s*)?(?:month|year|week|mo|yr))?)/i
  );
  if (currencyFirstMatch) {
    return currencyFirstMatch[1].replace(/\s+/g, " ").trim();
  }
  // International/currency-after format: e.g. "then 9.99 USD" or "then 9€"
  const currencyAfterMatch = text.match(
    /(?:then|renew(?:s|al)?(?:\s+at|\s+on)?|billed|charged)\s+(\d+(?:[.,]\d{1,2})?\s*(?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR)(?:\s*(?:per\s+|\/\s*)?(?:month|year|week|mo|yr))?)/i
  );
  return currencyAfterMatch?.[1]?.replace(/\s+/g, " ").trim();
}

function extractRenewalPeriod(text: string): string | undefined {
  const match = text.match(/(monthly|annually|yearly|weekly|per\s+month|per\s+year|per\s+week)/i);
  if (!match) {
    return undefined;
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

export function detectSubscriptionContext(args: {
  candidates: TextCandidate[];
  url: string;
  contextLoader: () => CheckoutContextResult;
  overrides?: KeywordOverrides;
}): DetectionResult | null {
  const { trial: trialRegexes, renewal: renewalRegexes, subscription: subscriptionRegexes } = getCompiledRegexes(args.overrides);

  const evidence = new Set<string>();
  let trialDays: number | undefined;
  let priceAfterTrial: string | undefined;
  let renewalPeriod: string | undefined;

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

    // Lazily compute visibility at most once per candidate — only when a regex first matches.
    let _visible: boolean | undefined;
    const isVisible = (): boolean => {
      if (_visible === undefined) {
        _visible = isCandidateVisible(candidate.element);
      }
      return _visible;
    };

    const trialMatch = trialRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isVisible()) {
        return false;
      }
      evidence.add(`trial:regex_${idx}`);
      return true;
    });

    const renewalMatch = renewalRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isVisible()) {
        return false;
      }
      evidence.add(`renewal:regex_${idx}`);
      return true;
    });

    const subscriptionMatch = subscriptionRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isVisible()) {
        return false;
      }
      evidence.add(`subscription:regex_${idx}`);
      return true;
    });

    if (trialMatch) {
      trialHits += 1;
      if (trialDays === undefined) {
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
  if (trialHits > 0 || trialDays !== undefined) {
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
