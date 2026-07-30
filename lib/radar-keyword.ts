export const RADAR_COUNTRY = "LK";
export const RADAR_COUNTRY_LABEL = "Sri Lanka";
export const DEFAULT_RADAR_KEYWORD = "cosmetics";
export const RADAR_KEYWORD_MIN_LENGTH = 2;
export const RADAR_KEYWORD_MAX_LENGTH = 80;

export type RadarKeywordValidation =
  | { ok: true; keyword: string }
  | { ok: false; error: string };

export function validateRadarKeyword(value: unknown): RadarKeywordValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter a product or niche to investigate." };
  }

  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return { ok: false, error: "Remove line breaks or control characters from the search." };
  }
  const keyword = value.trim();
  if (!keyword) {
    return { ok: false, error: "Enter a product or niche to investigate." };
  }
  if (keyword.length < RADAR_KEYWORD_MIN_LENGTH) {
    return { ok: false, error: "Use at least 2 characters." };
  }
  if (keyword.length > RADAR_KEYWORD_MAX_LENGTH) {
    return { ok: false, error: "Keep the search to 80 characters or fewer." };
  }

  return { ok: true, keyword };
}

export function parseRadarScanPayload(value: unknown): RadarKeywordValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Send a JSON object with a keyword." };
  }
  const body = value as Record<string, unknown>;
  if ("country" in body) {
    return { ok: false, error: "Country is fixed to Sri Lanka and cannot be changed." };
  }
  return validateRadarKeyword(body.keyword);
}

export function buildSriLankaMetaAdLibraryUrl(keyword: string): string {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: RADAR_COUNTRY,
    q: keyword,
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}
