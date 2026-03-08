const MULTI_PART_PUBLIC_SUFFIXES = new Set([
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

const GENERIC_COUNTRY_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gov", "mil", "net", "org"]);

function cleanHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

export function getHostname(url: string): string {
  try {
    return cleanHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

export function normalizeDomainInput(input: string): string {
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

function isIpLike(hostname: string): boolean {
  if (!hostname) {
    return false;
  }

  if (hostname === "localhost" || hostname.includes(":")) {
    return true;
  }

  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function getPublicSuffixLabelCount(parts: string[]): number {
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

export function getDomainKey(hostname: string): string {
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
