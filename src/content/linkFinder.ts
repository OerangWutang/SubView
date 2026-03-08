export type ManageCandidate = {
  url: string;
  label: string;
  score: number;
};

const KEYWORDS = ["manage", "cancel", "subscription", "billing", "account", "plan"];
// Pre-compiled combined check mirrors the substring matching used in scoreText; intentionally
// no word boundaries to stay consistent with the KEYWORDS.includes() calls below.
const KEYWORDS_QUICK_CHECK = /manage|cancel|subscription|billing|account|plan/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreText(text: string): number {
  const normalized = normalize(text);
  if (!KEYWORDS_QUICK_CHECK.test(normalized)) {
    return 0;
  }
  let score = 0;
  for (const keyword of KEYWORDS) {
    if (normalized.includes(keyword)) {
      score += keyword === "cancel" || keyword === "manage" ? 3 : 2;
    }
  }
  return score;
}

function absoluteUrl(href: string): string | null {
  try {
    return new URL(href, location.origin).toString();
  } catch {
    return null;
  }
}

export function findManageCandidates(): ManageCandidate[] {
  const candidates: ManageCandidate[] = [];

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

    const href =
      element instanceof HTMLAnchorElement
        ? element.href
        : element.getAttribute("data-href") ?? element.getAttribute("href") ?? "";

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

  const deduped = new Map<string, ManageCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.url);
    if (!existing || existing.score < candidate.score) {
      deduped.set(candidate.url, candidate);
    }
  }

  return [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 6);
}

export function buildHelpSearchUrl(domainKey: string): string {
  const query = `\"${domainKey}\" cancel subscription`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
