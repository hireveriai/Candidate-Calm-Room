import { resolveEffectiveQuestionCount } from "@/app/lib/interviewBudget";

export type InterviewQuestionSource = "resume" | "job" | "behavioral";
export type InterviewPhase = "warmup" | "core" | "probe" | "closing";

export type PlannedInterviewQuestion = {
  questionId: string | null;
  questionText: string;
  questionType: string | null;
  sourceType: string | null;
  questionOrder: number;
  allowFollowUp: boolean;
  difficultyLevel: number | null;
  phaseHint: string | null;
  targetSkillId: string | null;
  skillName: string | null;
};

export type AskedInterviewQuestion = {
  questionId: string | null;
  content: string;
  questionKind: string | null;
  normalizedKey: string;
  sourceType: InterviewQuestionSource;
  mappedSkillId: string | null;
};

export type InterviewBlueprint = {
  totalQuestions: number;
  distribution: Record<InterviewQuestionSource, number>;
};

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

function roundDownCounts(
  total: number,
  weights: Record<InterviewQuestionSource, number>
): Record<InterviewQuestionSource, number> {
  const rawEntries = (Object.keys(weights) as InterviewQuestionSource[]).map((key) => ({
    key,
    raw: total * weights[key],
  }));

  const counts = Object.fromEntries(
    rawEntries.map(({ key, raw }) => [key, Math.floor(raw)])
  ) as Record<InterviewQuestionSource, number>;

  let remainder = total - Object.values(counts).reduce((sum, value) => sum + value, 0);

  rawEntries
    .sort((a, b) => (b.raw % 1) - (a.raw % 1))
    .forEach(({ key }) => {
      if (remainder > 0) {
        counts[key] += 1;
        remainder -= 1;
      }
    });

  return counts;
}

export function normalizeQuestionKey(value: string | null | undefined) {
  return normalizeText(value).toLowerCase();
}

export function normalizeQuestionSource(
  sourceType: string | null | undefined
): InterviewQuestionSource | null {
  if (sourceType === "resume" || sourceType === "job" || sourceType === "behavioral") {
    return sourceType;
  }

  return null;
}

export function inferQuestionSource(params: {
  sourceType?: string | null;
  questionType?: string | null;
  content?: string | null;
}): InterviewQuestionSource {
  const direct = normalizeQuestionSource(params.sourceType);
  if (direct) {
    return direct;
  }

  const questionType = normalizeText(params.questionType).toLowerCase();
  const content = normalizeText(params.content).toLowerCase();

  if (
    questionType.includes("behavior") ||
    questionType.includes("leadership") ||
    questionType.includes("culture") ||
    content.includes("tell me about a time") ||
    content.includes("conflict") ||
    content.includes("stakeholder") ||
    content.includes("decision you made")
  ) {
    return "behavioral";
  }

  if (
    questionType.includes("resume") ||
    content.includes("background") ||
    content.includes("experience") ||
    content.includes("current role") ||
    content.includes("recent project") ||
    content.includes("walk me through your experience")
  ) {
    return "resume";
  }

  return "job";
}

function normalizeExperienceLevel(value: string | null | undefined) {
  const normalized = normalizeText(value).toLowerCase();

  if (
    normalized.includes("senior") ||
    normalized.includes("lead") ||
    normalized.includes("principal") ||
    normalized.includes("staff") ||
    normalized.includes("architect")
  ) {
    return "senior";
  }

  if (
    normalized.includes("junior") ||
    normalized.includes("entry") ||
    normalized.includes("associate") ||
    normalized.includes("fresher")
  ) {
    return "junior";
  }

  return "mid";
}

export function buildInterviewBlueprint(params: {
  configuredCount?: number | null;
  durationMinutes?: number | null;
  plannedQuestionCount?: number | null;
  experienceLevel?: string | null;
}): InterviewBlueprint {
  const totalQuestions = resolveEffectiveQuestionCount({
    configuredCount: params.configuredCount,
    durationMinutes: params.durationMinutes,
    plannedQuestionCount: params.plannedQuestionCount,
  });

  const experienceLevel = normalizeExperienceLevel(params.experienceLevel);

  const baseWeights =
    experienceLevel === "junior"
      ? { resume: 0.4, job: 0.4, behavioral: 0.2 }
      : experienceLevel === "senior"
        ? { resume: 0.25, job: 0.45, behavioral: 0.3 }
        : { resume: 0.3, job: 0.45, behavioral: 0.25 };

  return {
    totalQuestions,
    distribution: roundDownCounts(totalQuestions, baseWeights),
  };
}

export function deriveInterviewPhase(params: {
  askedTotal: number;
  totalQuestions: number;
}): InterviewPhase {
  const progress =
    params.totalQuestions > 0 ? params.askedTotal / Math.max(params.totalQuestions, 1) : 0;

  if (progress < 0.2) return "warmup";
  if (progress < 0.75) return "core";
  if (progress < 0.95) return "probe";
  return "closing";
}

export function buildAskedQuestionState(params: {
  askedQuestions: Array<{
    questionId: string | null;
    content: string;
    questionKind: string | null;
    mappedSkillId?: string | null;
  }>;
  plannedQuestions: PlannedInterviewQuestion[];
  requiredSkills?: Array<{
    skillId: string;
    skillName: string | null;
  }>;
}) {
  const plannedByQuestionId = new Map(
    params.plannedQuestions
      .filter((question) => question.questionId)
      .map((question) => [question.questionId as string, question])
  );
  const plannedByContent = new Map(
    params.plannedQuestions.map((question) => [
      normalizeQuestionKey(question.questionText),
      question,
    ])
  );

  const askedQuestions: AskedInterviewQuestion[] = params.askedQuestions.map((question) => {
    const normalizedKey = normalizeQuestionKey(question.content);
    const plannedQuestion =
      (question.questionId ? plannedByQuestionId.get(question.questionId) : undefined) ??
      plannedByContent.get(normalizedKey);
    const inferredSkillId =
      params.requiredSkills?.find((skill) =>
        normalizedKey.includes(normalizeQuestionKey(skill.skillName))
      )?.skillId ?? null;

    return {
      questionId: question.questionId,
      content: question.content,
      questionKind: question.questionKind,
      normalizedKey,
      sourceType: inferQuestionSource({
        sourceType: plannedQuestion?.sourceType,
        questionType: plannedQuestion?.questionType,
        content: question.content,
      }),
      mappedSkillId:
        question.mappedSkillId ??
        plannedQuestion?.targetSkillId ??
        inferredSkillId,
    };
  });

  const usedDistribution: Record<InterviewQuestionSource, number> = {
    resume: 0,
    job: 0,
    behavioral: 0,
  };
  const coveredSkillIds = new Set<string>();
  const usedQuestionIds = new Set<string>();
  const usedNormalizedKeys = new Set<string>();

  for (const question of askedQuestions) {
    usedNormalizedKeys.add(question.normalizedKey);

    if (question.questionId) {
      usedQuestionIds.add(question.questionId);
    }

    if (question.questionKind === "core") {
      usedDistribution[question.sourceType] += 1;
    }

    if (question.mappedSkillId) {
      coveredSkillIds.add(question.mappedSkillId);
    }
  }

  return {
    askedQuestions,
    usedDistribution,
    coveredSkillIds,
    usedQuestionIds,
    usedNormalizedKeys,
  };
}

export function getBlueprintDeficit(
  blueprint: InterviewBlueprint,
  usedDistribution: Record<InterviewQuestionSource, number>
) {
  const deficit: Record<InterviewQuestionSource, number> = {
    resume: Math.max(blueprint.distribution.resume - usedDistribution.resume, 0),
    job: Math.max(blueprint.distribution.job - usedDistribution.job, 0),
    behavioral: Math.max(blueprint.distribution.behavioral - usedDistribution.behavioral, 0),
  };

  return deficit;
}

export function pickNextExpectedSource(
  blueprint: InterviewBlueprint,
  usedDistribution: Record<InterviewQuestionSource, number>
): InterviewQuestionSource {
  const deficit = getBlueprintDeficit(blueprint, usedDistribution);

  return (Object.entries(deficit) as Array<[InterviewQuestionSource, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([source]) => source)[0] ?? "job";
}

export function selectNextCoreQuestion(params: {
  plannedQuestions: PlannedInterviewQuestion[];
  askedQuestions: Array<{
    questionId: string | null;
    content: string;
    questionKind: string | null;
    mappedSkillId?: string | null;
  }>;
  blueprint: InterviewBlueprint;
  targetDifficulty: number;
}) {
  const state = buildAskedQuestionState({
    askedQuestions: params.askedQuestions,
    plannedQuestions: params.plannedQuestions,
  });
  const phase = deriveInterviewPhase({
    askedTotal: params.askedQuestions.length,
    totalQuestions: params.blueprint.totalQuestions,
  });
  const deficit = getBlueprintDeficit(params.blueprint, state.usedDistribution);

  const candidates = params.plannedQuestions.filter((question) => {
    if (question.questionId && state.usedQuestionIds.has(question.questionId)) {
      return false;
    }

    return !state.usedNormalizedKeys.has(normalizeQuestionKey(question.questionText));
  });

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    const leftSource = inferQuestionSource(left);
    const rightSource = inferQuestionSource(right);
    const leftSkillUncovered =
      left.targetSkillId && !state.coveredSkillIds.has(left.targetSkillId) ? 1 : 0;
    const rightSkillUncovered =
      right.targetSkillId && !state.coveredSkillIds.has(right.targetSkillId) ? 1 : 0;
    const leftDeficit = deficit[leftSource];
    const rightDeficit = deficit[rightSource];
    const leftPhaseMatch = normalizeText(left.phaseHint).toLowerCase() === phase ? 1 : 0;
    const rightPhaseMatch = normalizeText(right.phaseHint).toLowerCase() === phase ? 1 : 0;
    const leftDifficultyGap = Math.abs((left.difficultyLevel ?? 3) - params.targetDifficulty);
    const rightDifficultyGap = Math.abs((right.difficultyLevel ?? 3) - params.targetDifficulty);

    return (
      rightSkillUncovered - leftSkillUncovered ||
      rightDeficit - leftDeficit ||
      rightPhaseMatch - leftPhaseMatch ||
      leftDifficultyGap - rightDifficultyGap ||
      left.questionOrder - right.questionOrder
    );
  })[0];
}

export function buildFallbackCoreQuestion(params: {
  sourceType: InterviewQuestionSource;
  skillName?: string | null;
  roleTitle?: string | null;
  phase?: InterviewPhase;
}) {
  const skillName = normalizeText(params.skillName);
  const roleTitle = normalizeText(params.roleTitle);
  const roleContext = roleTitle ? ` for a ${roleTitle}` : "";
  const skillContext = skillName || "this area";

  if (params.phase === "closing") {
    return `Before we wrap up, what is one decision you made recently${roleContext} that had the biggest impact, and why?`;
  }

  switch (params.sourceType) {
    case "resume":
      return `Can you walk me through a project from your background${roleContext} where you used ${skillContext} and the outcome you achieved?`;
    case "behavioral":
      return `Tell me about a time${roleContext} when you had to make a difficult decision while working on ${skillContext}. How did you handle it?`;
    case "job":
    default:
      return `This role${roleContext} requires strong ${skillContext}. How would you approach a real-world problem in that area?`;
  }
}

export function shouldCompleteInterview(params: {
  askedTotal: number;
  totalQuestions: number;
  elapsedSeconds: number;
  durationMinutes: number | null;
  requiredSkillIds: string[];
  coveredSkillIds: Set<string>;
}) {
  const durationSeconds = normalizePositiveInteger(params.durationMinutes) * 60;
  const timeExceeded = durationSeconds > 0 && params.elapsedSeconds >= durationSeconds;
  const enoughQuestions = params.askedTotal >= params.totalQuestions;
  const coverageSatisfied =
    params.requiredSkillIds.length === 0 ||
    params.requiredSkillIds.every((skillId) => params.coveredSkillIds.has(skillId));

  return {
    complete: timeExceeded || (enoughQuestions && coverageSatisfied),
    timeExceeded,
    coverageSatisfied,
    enoughQuestions,
  };
}
