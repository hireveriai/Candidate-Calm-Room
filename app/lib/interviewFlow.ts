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

const ROLE_SEGMENT_SPLIT = /\s+\|\s+|\s+-\s+|\s+–\s+|\s+—\s+|,\s*/;
const ROLE_KEYWORDS = [
  "administrator",
  "admin",
  "architect",
  "analyst",
  "consultant",
  "coordinator",
  "database",
  "developer",
  "devops",
  "engineer",
  "lead",
  "manager",
  "officer",
  "principal",
  "specialist",
  "staff",
];
const ROLE_NOISE_TOKENS = new Set([
  "apac",
  "asia",
  "bangalore",
  "bengaluru",
  "blr",
  "chennai",
  "delhi",
  "dubai",
  "emea",
  "europe",
  "gurgaon",
  "gurugram",
  "holland",
  "hybrid",
  "hyderabad",
  "india",
  "kolkata",
  "london",
  "mumbai",
  "netherlands",
  "noida",
  "onsite",
  "on-site",
  "pune",
  "remote",
  "singapore",
  "uae",
  "uk",
  "usa",
  "us",
  "wfh",
]);
const ROLE_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bsr\.?\b/gi, "Senior"],
  [/\bjr\.?\b/gi, "Junior"],
  [/\bassoc\.?\b/gi, "Associate"],
];

function isRoleNoiseToken(token: string) {
  const normalized = token.toLowerCase();

  if (!normalized) {
    return false;
  }

  return ROLE_NOISE_TOKENS.has(normalized);
}

function standardizeRoleCasing(value: string) {
  return value
    .split(/\s+/)
    .map((token) => {
      if (/^[A-Z0-9]{2,}$/.test(token)) {
        return token;
      }

      const lower = token.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function scoreRoleSegment(segment: string) {
  const normalized = normalizeText(segment).toLowerCase();

  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  const tokens = normalized.split(/\s+/);

  return tokens.reduce((score, token) => {
    if (ROLE_KEYWORDS.some((keyword) => token.includes(keyword))) {
      return score + 3;
    }

    if (isRoleNoiseToken(token)) {
      return score - 3;
    }

    if (/shift|remote|hybrid|onsite|on-site/.test(token)) {
      return score - 2;
    }

    return score + 1;
  }, 0);
}

export function cleanRoleTitle(value: string | null | undefined) {
  let cleaned = normalizeText(value);

  if (!cleaned) {
    return null;
  }

  cleaned = cleaned.replace(
    /\((?:[^)]*\b(?:remote|hybrid|onsite|on-site|wfh|work from home|shift|bangalore|bengaluru|holland|netherlands|india|uk|usa|us)\b[^)]*)\)/gi,
    " "
  );

  for (const [pattern, replacement] of ROLE_ABBREVIATIONS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  const segments = cleaned
    .split(ROLE_SEGMENT_SPLIT)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);

  if (segments.length > 1) {
    cleaned = [...segments].sort((left, right) => scoreRoleSegment(right) - scoreRoleSegment(left))[0];
  }

  cleaned = cleaned
    .replace(/\b(remote|hybrid|onsite|on-site|work from home|wfh)\b/gi, " ")
    .replace(
      /\b(day|night|rotational|general|morning|evening|first|second|third|1st|2nd|3rd|us|uk|europe|emea|apac|ist)\s+shift\b/gi,
      " "
    )
    .replace(/\bshift\s*[a-z0-9:+-]*\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  let tokens = cleaned.split(/\s+/).filter(Boolean);

  while (tokens.length > 0 && isRoleNoiseToken(tokens[0])) {
    tokens = tokens.slice(1);
  }

  while (tokens.length > 0 && isRoleNoiseToken(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }

  cleaned = standardizeRoleCasing(tokens.join(" "));
  return cleaned || null;
}

export function extractResponsibilityAnchors(
  value: string | null | undefined,
  limit = 4
) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  return [...new Set(
    normalized
      .split(/[.;\n\r]+/)
      .map((segment) => normalizeText(segment))
      .filter((segment) => {
        const wordCount = segment.split(/\s+/).length;
        return (
          wordCount >= 4 &&
          wordCount <= 18 &&
          /\b(handle|manage|maintain|monitor|optimi[sz]e|troubleshoot|support|design|deliver|migrate|automate|secure|improve|own|lead)\b/i.test(
            segment
          )
        );
      })
      .map((segment) => segment.replace(/^(responsibilities?|requirements?)\s*[:\-]\s*/i, ""))
  )].slice(0, limit);
}

function normalizeAnchorToken(value: string | null | undefined) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractClaimAnchors(
  values: Array<string | null | undefined>,
  limit = 6
) {
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) {
      continue;
    }

    const segments = normalized.split(/[.;,\n\r]+/);
    for (const segment of segments) {
      const claim = normalizeText(segment);
      const wordCount = claim.split(/\s+/).length;
      if (claim && wordCount >= 2 && wordCount <= 10 && !result.includes(claim)) {
        result.push(claim);
      }

      if (result.length >= limit) {
        return result;
      }
    }
  }

  return result;
}

export function computeSkillOverlap(params: {
  resumeSkills?: Array<string | null | undefined>;
  resumeClaims?: Array<string | null | undefined>;
  jobSkills?: Array<string | null | undefined>;
}) {
  const resumeAnchors = [...new Set([
    ...(params.resumeSkills ?? []).map((value) => normalizeText(value)).filter(Boolean),
    ...extractClaimAnchors(params.resumeClaims ?? []),
  ])];
  const jobSkills = [...new Set((params.jobSkills ?? []).map((value) => normalizeText(value)).filter(Boolean))];
  const jobSkillMap = new Map(jobSkills.map((skill) => [normalizeAnchorToken(skill), skill]));
  const overlap: string[] = [];

  for (const anchor of resumeAnchors) {
    const normalized = normalizeAnchorToken(anchor);
    const direct = jobSkillMap.get(normalized);

    if (direct && !overlap.includes(direct)) {
      overlap.push(direct);
      continue;
    }

    const partial = jobSkills.find((jobSkill) => {
      const normalizedJobSkill = normalizeAnchorToken(jobSkill);
      return (
        normalized.length >= 4 &&
        normalizedJobSkill.length >= 4 &&
        (normalized.includes(normalizedJobSkill) || normalizedJobSkill.includes(normalized))
      );
    });

    if (partial && !overlap.includes(partial)) {
      overlap.push(partial);
    }
  }

  return {
    overlapSkills: overlap,
    resumeAnchors,
    jobSkills,
  };
}

export function pickQuestionAnchor(params: {
  sourceType: InterviewQuestionSource;
  overlapSkills?: Array<string | null | undefined>;
  preferredJobSkill?: string | null;
  resumeSkills?: Array<string | null | undefined>;
  resumeClaims?: Array<string | null | undefined>;
  responsibilities?: Array<string | null | undefined>;
  fallbackRoleTitle?: string | null;
}) {
  const overlapSkills = (params.overlapSkills ?? []).map((value) => normalizeText(value)).filter(Boolean);
  const preferredJobSkill = normalizeText(params.preferredJobSkill);
  const resumeSkills = (params.resumeSkills ?? []).map((value) => normalizeText(value)).filter(Boolean);
  const resumeClaims = extractClaimAnchors(params.resumeClaims ?? []);
  const responsibilities = (params.responsibilities ?? []).map((value) => normalizeText(value)).filter(Boolean);
  const fallbackRoleTitle = cleanRoleTitle(params.fallbackRoleTitle);

  if (overlapSkills[0]) {
    return overlapSkills[0];
  }

  if (preferredJobSkill) {
    return preferredJobSkill;
  }

  if (params.sourceType === "resume") {
    return resumeSkills[0] || resumeClaims[0] || responsibilities[0] || fallbackRoleTitle || "your recent work";
  }

  if (params.sourceType === "behavioral") {
    return responsibilities[0] || preferredJobSkill || overlapSkills[0] || resumeSkills[0] || fallbackRoleTitle || "your work";
  }

  return preferredJobSkill || responsibilities[0] || resumeSkills[0] || resumeClaims[0] || fallbackRoleTitle || "this area";
}

function normalizePositiveInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

function stableTemplateIndex(value: string, modulo: number) {
  if (modulo <= 0) {
    return 0;
  }

  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash % modulo;
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
  contextAnchor?: string | null;
  roleTitle?: string | null;
  phase?: InterviewPhase;
}) {
  const skillContext =
    normalizeText(params.skillName) ||
    normalizeText(params.contextAnchor) ||
    cleanRoleTitle(params.roleTitle) ||
    "this area";
  const templateSeed = `${params.sourceType}:${params.phase ?? "core"}:${skillContext}`;

  if (params.phase === "closing") {
    return `Before we wrap up, what is one recent decision you made while working on ${skillContext}, and why did it matter?`;
  }

  switch (params.sourceType) {
    case "resume": {
      const templates = [
        `What was the hardest problem you solved using ${skillContext}, and how did you get it over the line?`,
        `When you worked on ${skillContext}, what concrete result were you accountable for and how did you deliver it?`,
        `Take me through a project where ${skillContext} became critical. What broke, what did you change, and what improved?`,
      ];
      return templates[stableTemplateIndex(templateSeed, templates.length)];
    }
    case "behavioral": {
      const templates = [
        `When work around ${skillContext} started going off track, how did you regain control and align the team?`,
        `Think of a time you had conflicting priorities around ${skillContext}. How did you decide what to protect first?`,
        `When stakeholders pushed for speed on ${skillContext}, how did you defend quality or risk controls?`,
      ];
      return templates[stableTemplateIndex(templateSeed, templates.length)];
    }
    case "job":
    default: {
      const templates = [
        `How do you troubleshoot ${skillContext} when it starts failing in production?`,
        `If you had to improve ${skillContext} under real delivery pressure, what would you look at first?`,
        `What signals tell you ${skillContext} is degrading, and what actions do you take next?`,
        `Walk me through the steps you would take to execute ${skillContext} reliably in production.`,
      ];
      return templates[stableTemplateIndex(templateSeed, templates.length)];
    }
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
