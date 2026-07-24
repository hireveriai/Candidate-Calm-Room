export const MOTIVATION_CLOSING_STAGE = "motivation";
export const CANDIDATE_CLOSING_STAGE = "candidate_closing";

export type InterviewClosingStage =
  | typeof MOTIVATION_CLOSING_STAGE
  | typeof CANDIDATE_CLOSING_STAGE;

export type CandidateCareerStage =
  | "employed"
  | "fresher"
  | "returning"
  | "unknown";

type AskedClosingQuestion = {
  questionKind?: string | null;
  sourceContext?: unknown;
};

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getClosingStage(sourceContext: unknown) {
  const stage = asRecord(sourceContext)?.["ending_stage"];
  return stage === MOTIVATION_CLOSING_STAGE || stage === CANDIDATE_CLOSING_STAGE
    ? stage
    : null;
}

export function inferCandidateCareerStage(params: {
  candidateExperience?: string | null;
  experienceLevel?: string | null;
  claimedExperienceYears?: number | null;
  resumeText?: string | null;
  extractedClaims?: unknown;
}): CandidateCareerStage {
  const evidence = [
    params.candidateExperience,
    params.experienceLevel,
    params.resumeText,
    JSON.stringify(params.extractedClaims ?? ""),
  ]
    .map(normalizeText)
    .join(" ")
    .toLowerCase();

  if (
    /\b(career\s+break|career\s+gap|employment\s+gap|sabbatical|return(?:ing)?\s+to\s+work|currently\s+not\s+working|not\s+currently\s+working)\b/.test(
      evidence
    )
  ) {
    return "returning";
  }

  if (
    /\b(fresher|fresh\s+graduate|recent\s+graduate|student|entry[-\s]?level|no\s+(?:professional\s+)?experience)\b/.test(
      evidence
    ) ||
    (params.claimedExperienceYears === 0 &&
      !/\b(present|currently\s+working|till\s+date|current\s+role)\b/.test(evidence))
  ) {
    return "fresher";
  }

  if (
    /\b(present|currently\s+(?:working|employed)|current\s+role|current\s+company|till\s+date)\b/.test(
      evidence
    )
  ) {
    return "employed";
  }

  return "unknown";
}

export function buildMotivationQuestion(careerStage: CandidateCareerStage) {
  switch (careerStage) {
    case "employed":
      return "What is motivating you to consider a change from your current role?";
    case "fresher":
      return "What interests you about starting your career in this type of role?";
    case "returning":
      return "What is motivating you to return to work and explore this opportunity?";
    default:
      return "What is motivating you to explore this opportunity at this stage of your career?";
  }
}

export const CANDIDATE_CLOSING_QUESTION =
  "Is there anything else about your experience or suitability for this role that you would like the recruiter to know?";

export function getNextRequiredClosingQuestion(params: {
  askedQuestions: AskedClosingQuestion[];
  careerStage: CandidateCareerStage;
}) {
  const askedStages = new Set(
    params.askedQuestions
      .filter((question) => question.questionKind === "closing")
      .map((question) => getClosingStage(question.sourceContext))
      .filter((stage): stage is InterviewClosingStage => Boolean(stage))
  );

  if (!askedStages.has(MOTIVATION_CLOSING_STAGE)) {
    return {
      stage: MOTIVATION_CLOSING_STAGE,
      question: buildMotivationQuestion(params.careerStage),
    } as const;
  }

  if (!askedStages.has(CANDIDATE_CLOSING_STAGE)) {
    return {
      stage: CANDIDATE_CLOSING_STAGE,
      question: CANDIDATE_CLOSING_QUESTION,
    } as const;
  }

  return null;
}

export function hasStartedRequiredClosingSequence(
  askedQuestions: AskedClosingQuestion[]
) {
  return askedQuestions.some(
    (question) =>
      question.questionKind === "closing" &&
      getClosingStage(question.sourceContext) !== null
  );
}
