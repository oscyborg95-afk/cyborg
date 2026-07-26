import type {
  CustomerLanguage,
  CustomerLanguageStyle,
  LanguageAssessment,
} from "./types";

const SINHALA = /[\u0D80-\u0DFF]/g;
const TAMIL = /[\u0B80-\u0BFF]/g;
const LATIN_WORD = /[a-z]+/gi;

const SINHALA_LATIN_MARKERS = new Set([
  "ada", "ai", "ane", "awa", "balanna", "ba", "da", "denna", "eka", "ekak",
  "ganna", "hari", "kohomada", "kiyada", "mata", "me", "nadda", "nam", "ona",
  "puluwanda", "thiyenawada", "wada",
]);

const TAMIL_LATIN_MARKERS = new Set([
  "aama", "anna", "enna", "epdi", "evlo", "irukka", "illa", "intha", "na",
  "naan", "ok", "onnu", "romba", "seri", "venum", "ya",
]);

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function latinMarkerScore(words: string[], markers: Set<string>): number {
  return words.reduce((score, word) => score + (markers.has(word.toLowerCase()) ? 1 : 0), 0);
}

export function inferNativeStyle(
  text: string,
  language: Exclude<CustomerLanguage, "auto">
): CustomerLanguageStyle {
  const sinhala = countMatches(text, SINHALA);
  const tamil = countMatches(text, TAMIL);
  if (language === "si") return sinhala > 0 ? "si_native" : "si_latin";
  if (language === "ta") return tamil > 0 ? "ta_native" : "ta_latin";
  return "en";
}

export function detectLanguageHeuristic(
  text: string,
  preferredLanguage: CustomerLanguage = "auto"
): LanguageAssessment | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (preferredLanguage !== "auto") {
    return {
      language: preferredLanguage,
      style: inferNativeStyle(normalized, preferredLanguage),
      confidence: 1,
      explicit: true,
      evidence: "Customer language was selected manually.",
    };
  }

  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))[!.?\s]*$/i.test(normalized)) {
    return {
      language: "en",
      style: "en",
      confidence: 0.94,
      explicit: false,
      evidence: "The customer used a conventional English greeting.",
    };
  }

  const sinhala = countMatches(normalized, SINHALA);
  const tamil = countMatches(normalized, TAMIL);
  const latin = countMatches(normalized, /[A-Za-z]/g);
  const scriptTotal = sinhala + tamil + latin;

  if (sinhala >= 2 && sinhala > tamil * 2) {
    return {
      language: "si",
      style: latin > sinhala ? "mixed" : "si_native",
      confidence: Math.min(0.99, 0.9 + sinhala / Math.max(100, scriptTotal)),
      explicit: false,
      evidence: "The latest customer message uses Sinhala script.",
    };
  }
  if (tamil >= 2 && tamil > sinhala * 2) {
    return {
      language: "ta",
      style: latin > tamil ? "mixed" : "ta_native",
      confidence: Math.min(0.99, 0.9 + tamil / Math.max(100, scriptTotal)),
      explicit: false,
      evidence: "The latest customer message uses Tamil script.",
    };
  }

  const words = normalized.match(LATIN_WORD) ?? [];
  const siScore = latinMarkerScore(words, SINHALA_LATIN_MARKERS);
  const taScore = latinMarkerScore(words, TAMIL_LATIN_MARKERS);
  if (siScore >= 2 && siScore >= taScore + 1) {
    return {
      language: "si",
      style: "si_latin",
      confidence: Math.min(0.94, 0.76 + siScore * 0.06),
      explicit: false,
      evidence: "The message contains multiple common Singlish markers.",
    };
  }
  if (taScore >= 2 && taScore >= siScore + 1) {
    return {
      language: "ta",
      style: "ta_latin",
      confidence: Math.min(0.94, 0.76 + taScore * 0.06),
      explicit: false,
      evidence: "The message contains multiple common Tanglish markers.",
    };
  }
  if (words.length >= 4 && siScore === 0 && taScore === 0) {
    return {
      language: "en",
      style: "en",
      confidence: 0.84,
      explicit: false,
      evidence: "The message is a multi-word Latin-script message without local-language markers.",
    };
  }
  return null;
}

export function validateReplyScript(
  reply: string,
  style: CustomerLanguageStyle
): { valid: boolean; reason: string } {
  const sinhala = countMatches(reply, SINHALA);
  const tamil = countMatches(reply, TAMIL);
  if (style === "si_native" && sinhala < 2) {
    return { valid: false, reason: "Reply is missing Sinhala script." };
  }
  if (style === "ta_native" && tamil < 2) {
    return { valid: false, reason: "Reply is missing Tamil script." };
  }
  if (style === "si_latin" && (sinhala > 0 || tamil > 0)) {
    return { valid: false, reason: "Singlish reply unexpectedly changed script." };
  }
  if (style === "ta_latin" && (sinhala > 0 || tamil > 0)) {
    return { valid: false, reason: "Tanglish reply unexpectedly changed script." };
  }
  if (style === "en" && (sinhala > 0 || tamil > 0)) {
    return { valid: false, reason: "English reply unexpectedly changed script." };
  }
  return { valid: true, reason: "" };
}
