export const MAX_CLARIFICATIONS_PER_QUESTION = 2;

const CLARIFICATION_PATTERNS = [
  /\b(?:i\s+)?(?:do\s+not|don't|did\s+not|didn't|cannot|can't|could\s+not|couldn't)\s+(?:quite\s+)?(?:understand|get|follow)\s+(?:the|this|that|your)?\s*question\b/i,
  /\b(?:i(?:'m|\s+am)\s+)?not\s+(?:quite\s+)?sure\s+(?:what|which)\s+(?:you(?:'re|\s+are)\s+asking|the\s+question\s+means)\b/i,
  /\bwhat\s+do\s+you\s+mean\b/i,
  /\bwhat\s+(?:exactly\s+)?(?:are\s+you|do\s+you\s+want\s+me\s+to)\s+ask(?:ing)?\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:explain|clarify|rephrase|repeat|say)\s+(?:that|this|it|the\s+question)(?:\s+(?:again|differently|more\s+simply))?\b/i,
  /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:put|say|explain)\s+(?:that|this|it)\s+in\s+(?:simpler|different|other)\s+(?:words|language|terms)\b/i,
  /\b(?:please\s+)?(?:explain|clarify|rephrase|repeat)\s+(?:that|this|it|the\s+question)(?:\s+(?:again|differently|more\s+simply))?\b/i,
  /\b(?:i\s+am|i'm)\s+not\s+able\s+to\s+understand\s+(?:the|this|that)?\s*question\b/i,
];

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function isClarificationRequest(value: string | null | undefined) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount > 24) {
    return false;
  }

  if (
    /\b(?:at\s+first|initially|earlier)\b/i.test(normalized) &&
    /\b(?:but|then|now|eventually)\b/i.test(normalized)
  ) {
    return false;
  }

  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SIMPLER_LANGUAGE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\butili[sz]e\b/gi, "use"],
  [/\bimplement(?:ation)?\b/gi, "put into practice"],
  [/\boptimi[sz]e\b/gi, "improve"],
  [/\bmitigate\b/gi, "reduce"],
  [/\bprioriti[sz]ing\s+outcomes?\b/gi, "deciding which results matter most"],
  [/\bprioriti[sz]e\s+outcomes?\b/gi, "decide which results matter most"],
  [/\bprioriti[sz](?:e|ing)\b/gi, "decide what comes first"],
  [/\bstakeholders?\b/gi, "people involved"],
  [/\bcollaborating\s+with\b/gi, "working with"],
  [/\bcollaborate\s+with\b/gi, "work with"],
  [/\bchallenges?\b/gi, "problems"],
  [/\boutcomes?\b/gi, "results"],
  [/\bmethodology\b/gi, "method"],
  [/\bapproach\s+to\b/gi, "way of"],
  [/\bapproach\b/gi, "way"],
  [/\bensure\b/gi, "make sure"],
  [/\belaborate on\b/gi, "explain"],
  [/\bdescribe\b/gi, "tell me about"],
];

export function buildSafeClarificationFallback(originalQuestion: string) {
  let simplified = normalizeText(originalQuestion);

  for (const [pattern, replacement] of SIMPLER_LANGUAGE_REPLACEMENTS) {
    simplified = simplified.replace(pattern, replacement);
  }

  simplified = simplified
    .replace(/\s+/g, " ")
    .replace(/\s+\?/g, "?")
    .trim();
  simplified = `${simplified.charAt(0).toUpperCase()}${simplified.slice(1)}`;

  if (!simplified) {
    return "Could you answer the same question using a simple example from your own experience?";
  }

  if (simplified.toLowerCase() === normalizeText(originalQuestion).toLowerCase()) {
    return `In simpler terms, ${simplified.charAt(0).toLowerCase()}${simplified.slice(1)}`;
  }

  return simplified;
}

export function sanitizeClarifiedQuestion(
  value: string | null | undefined,
  originalQuestion: string
) {
  const fallback = buildSafeClarificationFallback(originalQuestion);
  const candidate = normalizeText(value)
    .replace(/^clarified[_\s-]*question\s*[:\-]\s*/i, "")
    .replace(/^question\s*[:\-]\s*/i, "");

  if (!candidate || candidate.length > 800) {
    return fallback;
  }

  return candidate.endsWith("?") ? candidate : `${candidate}?`;
}
