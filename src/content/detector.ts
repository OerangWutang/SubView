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
  /then\s+([$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s*\d/i,
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
  const match = text.match(
    /(?:then|renew(?:s|al)?(?:\s+at|\s+on)?|billed|charged)[^$€£¥₹\d]{0,20}((?:[$€£¥₹]|USD|CAD|AUD|GBP|EUR)\s?\d+(?:[.,]\d{1,2})?(?:\s*(?:per\s+|\/\s*)?(?:month|year|week|mo|yr))?)/i
  );
  return match?.[1]?.replace(/\s+/g, " ").trim();
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
  const trialRegexes = [...BASE_TRIAL_REGEX, ...keywordRegexes(args.overrides?.trial ?? [])];
  const renewalRegexes = [...BASE_RENEWAL_REGEX, ...keywordRegexes(args.overrides?.renewal ?? [])];
  const subscriptionRegexes = [...BASE_SUBSCRIPTION_REGEX, ...keywordRegexes(args.overrides?.subscription ?? [])];

  const baseTrialCount = BASE_TRIAL_REGEX.length;
  const baseRenewalCount = BASE_RENEWAL_REGEX.length;
  const baseSubscriptionCount = BASE_SUBSCRIPTION_REGEX.length;

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

    const trialMatch = trialRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isCandidateVisible(candidate.element)) {
        return false;
      }
      evidence.add(idx < baseTrialCount ? `trial:regex_${idx}` : `trial:custom_${idx - baseTrialCount}`);
      return true;
    });

    const renewalMatch = renewalRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isCandidateVisible(candidate.element)) {
        return false;
      }
      evidence.add(idx < baseRenewalCount ? `renewal:regex_${idx}` : `renewal:custom_${idx - baseRenewalCount}`);
      return true;
    });

    const subscriptionMatch = subscriptionRegexes.some((regex, idx) => {
      if (!regex.test(text)) {
        return false;
      }
      if (!isCandidateVisible(candidate.element)) {
        return false;
      }
      evidence.add(idx < baseSubscriptionCount ? `subscription:regex_${idx}` : `subscription:custom_${idx - baseSubscriptionCount}`);
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
