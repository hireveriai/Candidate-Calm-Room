function normalizePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

export function deriveQuestionTargetFromDuration(durationMinutes: number | null | undefined) {
  const duration = normalizePositiveInteger(durationMinutes);

  if (duration >= 60) return 17;
  if (duration >= 45) return 13;
  if (duration >= 30) return 9;
  if (duration >= 20) return 7;
  if (duration >= 15) return 5;
  if (duration >= 10) return 4;
  if (duration > 0) return 3;
  return 9;
}

export function resolveEffectiveQuestionCount(params: {
  configuredCount?: number | null;
  durationMinutes?: number | null;
  plannedQuestionCount?: number | null;
}) {
  const configuredCount = normalizePositiveInteger(params.configuredCount);
  const plannedQuestionCount = normalizePositiveInteger(params.plannedQuestionCount);
  const durationMinutes = normalizePositiveInteger(params.durationMinutes);
  const durationTarget = deriveQuestionTargetFromDuration(durationMinutes);

  let effectiveCount = Math.max(configuredCount, plannedQuestionCount, 1);

  // Guard against stale or undersized question_count values on longer interviews.
  if (durationMinutes >= 25 && effectiveCount < 5) {
    effectiveCount = Math.max(effectiveCount, durationTarget, plannedQuestionCount);
  }

  if (effectiveCount === 1 && plannedQuestionCount === 0) {
    effectiveCount = Math.max(effectiveCount, durationTarget);
  }

  return effectiveCount;
}
