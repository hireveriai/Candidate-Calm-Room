function normalizePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

export function deriveQuestionTargetFromDuration(durationMinutes: number | null | undefined) {
  const duration = normalizePositiveInteger(durationMinutes);

  if (duration >= 60) return 11;
  if (duration >= 45) return 8;
  if (duration >= 30) return 6;
  if (duration >= 20) return 4;
  if (duration >= 15) return 3;
  if (duration >= 10) return 2;
  if (duration > 0) return 2;
  return 6;
}

function deriveMinimumQuestionTargetFromDuration(durationMinutes: number | null | undefined) {
  const duration = normalizePositiveInteger(durationMinutes);

  if (duration >= 60) return 8;
  if (duration >= 45) return 6;
  if (duration >= 30) return 5;
  if (duration >= 20) return 3;
  if (duration >= 15) return 2;
  if (duration >= 10) return 2;
  if (duration > 0) return 1;
  return 1;
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
  const durationFloor = deriveMinimumQuestionTargetFromDuration(durationMinutes);
  const requestedCount = Math.max(configuredCount, plannedQuestionCount, 0);

  if (durationMinutes === 0) {
    return Math.max(requestedCount, 1);
  }

  if (requestedCount === 0) {
    return durationTarget;
  }

  return Math.min(Math.max(requestedCount, durationFloor), durationTarget);
}
