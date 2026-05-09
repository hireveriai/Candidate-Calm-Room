function normalizePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

export type DeterministicInterviewBudget = {
  durationMinutes: number;
  targetPrimaryQuestions: number;
  minimumPrimaryQuestions: number;
  maxFollowUpsPerPrimary: number;
  hardTotalQuestionCap: number;
  maxAiRetries: number;
  maxGenerationLoops: number;
  maxCompletionRetries: number;
};

export function buildDeterministicInterviewBudget(
  durationMinutes: number | null | undefined
): DeterministicInterviewBudget {
  const duration = normalizePositiveInteger(durationMinutes);

  if (duration >= 60) {
    return {
      durationMinutes: duration,
      targetPrimaryQuestions: 15,
      minimumPrimaryQuestions: 12,
      maxFollowUpsPerPrimary: 2,
      hardTotalQuestionCap: 40,
      maxAiRetries: 3,
      maxGenerationLoops: 6,
      maxCompletionRetries: 3,
    };
  }

  if (duration >= 45) {
    return {
      durationMinutes: duration,
      targetPrimaryQuestions: 12,
      minimumPrimaryQuestions: 10,
      maxFollowUpsPerPrimary: 2,
      hardTotalQuestionCap: 30,
      maxAiRetries: 3,
      maxGenerationLoops: 5,
      maxCompletionRetries: 3,
    };
  }

  if (duration >= 30) {
    return {
      durationMinutes: duration,
      targetPrimaryQuestions: 8,
      minimumPrimaryQuestions: 6,
      maxFollowUpsPerPrimary: 2,
      hardTotalQuestionCap: 22,
      maxAiRetries: 2,
      maxGenerationLoops: 4,
      maxCompletionRetries: 3,
    };
  }

  if (duration >= 10) {
    return {
      durationMinutes: duration,
      targetPrimaryQuestions: 4,
      minimumPrimaryQuestions: 3,
      maxFollowUpsPerPrimary: 2,
      hardTotalQuestionCap: 10,
      maxAiRetries: 2,
      maxGenerationLoops: 3,
      maxCompletionRetries: 2,
    };
  }

  return {
    durationMinutes: duration,
    targetPrimaryQuestions: 4,
    minimumPrimaryQuestions: 2,
    maxFollowUpsPerPrimary: 1,
    hardTotalQuestionCap: 8,
    maxAiRetries: 2,
    maxGenerationLoops: 3,
    maxCompletionRetries: 2,
  };
}

export function deriveQuestionTargetFromDuration(durationMinutes: number | null | undefined) {
  return buildDeterministicInterviewBudget(durationMinutes).targetPrimaryQuestions;
}

function deriveMinimumQuestionTargetFromDuration(durationMinutes: number | null | undefined) {
  return buildDeterministicInterviewBudget(durationMinutes).minimumPrimaryQuestions;
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
