type SpokenAnswerForIntegrity = {
  answer_text?: string | null;
  answer_payload?: unknown | null;
  code_text?: string | null;
};

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isNoResponse(value: unknown) {
  return /^no response provided\.?$/i.test(normalizeText(value));
}

function wordCount(value: unknown) {
  return normalizeText(value).split(/\s+/).filter(Boolean).length;
}

function payloadDurationSeconds(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return 0;
  }

  const duration = Number((payload as Record<string, unknown>).duration ?? 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function hasRecordingTranscriptVerification(payload: unknown) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).recording_transcript_verified_at
  );
}

export function isLikelyIncompleteSpokenAnswer(row: SpokenAnswerForIntegrity) {
  if (normalizeText(row.code_text)) {
    return false;
  }

  const answer = normalizeText(row.answer_text);
  if (!answer || isNoResponse(answer)) {
    return true;
  }

  const duration = payloadDurationSeconds(row.answer_payload);
  const words = wordCount(answer);
  const wordsPerSecond =
    duration > 0 ? words / duration : Number.POSITIVE_INFINITY;
  const endsMidSentence =
    /\b(and|but|because|so|to|the|a|an|if|when|with|for|of|or)$/i.test(answer);

  // Normal conversational speech is usually well above this threshold. Keep
  // it deliberately conservative so slow speakers are not needlessly repaired.
  return (
    (duration >= 45 && wordsPerSecond < 0.9) ||
    (duration >= 15 && words >= 8 && endsMidSentence)
  );
}

export function hasUnverifiedIncompleteSpokenAnswer(
  row: SpokenAnswerForIntegrity
) {
  return (
    !hasRecordingTranscriptVerification(row.answer_payload) &&
    isLikelyIncompleteSpokenAnswer(row)
  );
}

