/**
 * Role-aware answer evaluation planning.
 *
 * Decides, for one answered question, which rubric the AI evaluator should use.
 * Shared by the live per-answer route and the recording repair pipeline so a
 * recovered answer is judged exactly like a normally captured one.
 *
 * Why this exists: an open-ended question with no keyword signal is classified
 * as TECHNICAL_DISCUSSION, and words such as "strategy" or "how would you
 * build" classify as ARCHITECTURE / SYSTEM_DESIGN. For a technical role that is
 * intended. For a Sales Manager, Teacher or HR Manager it meant answers were
 * scored for "technical depth" and "architecture understanding". Technical
 * rubrics are now only used when the job itself is technical; every other role
 * gets a role-neutral rubric, and the question's own stored evaluation
 * criteria take priority for all roles.
 *
 * Pure: no I/O, so it is unit-testable without a database.
 */

import {
  classifyInterviewQuestion,
  InterviewQuestionType,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";
import { resolveRoleContext, type RoleContext, type RoleContextKind } from "@/app/lib/roleContext";

export type SkillType = "technical" | "functional" | "behavioral";

/** Question types whose default rubric assumes a technical role. */
const TECHNICAL_ONLY_TYPES = new Set<InterviewQuestionType>([
  InterviewQuestionType.TECHNICAL_DISCUSSION,
  InterviewQuestionType.SYSTEM_DESIGN,
  InterviewQuestionType.ARCHITECTURE,
  InterviewQuestionType.TROUBLESHOOTING,
]);

const TECHNICAL_SKILL_PATTERN =
  /\b(sql|database|postgres|postgresql|mysql|oracle|python|java|typescript|javascript|react|node|api|etl|performance|backup|recovery|debug|coding|programming)\b/i;

export const ROLE_NEUTRAL_RUBRIC =
  "Evaluate the answer as an experienced practitioner of this role would: relevant role knowledge used correctly, sound judgement and the reasoning behind decisions, a concrete first-hand example, handling of people, stakeholders or constraints where relevant, and a clear observable outcome. For planning or strategy questions also consider prioritisation and trade-offs. Use the role's own terminology and do not expect software, engineering or technical detail unless the question itself asks for it.";

/** Label sent to the evaluator when a technical-only type is neutralised. */
export const ROLE_NEUTRAL_QUESTION_TYPE_LABEL = "role_discussion";

const MAX_CRITERIA_LENGTH = 600;

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Behavioural / technical / functional classification used by the evaluator
 * payload and by follow-up generation. A non-technical role is never
 * "technical": skill names such as "performance management" or "backup
 * planning" previously matched the technical keyword list.
 */
export function deriveSkillType(
  sourceType: string | null | undefined,
  skillName: string | null | undefined,
  questionType?: string | null,
  roleContext?: RoleContextKind | null
): SkillType {
  if (questionType === InterviewQuestionType.BEHAVIORAL) {
    return "behavioral";
  }

  if (sourceType === "behavioral") {
    return "behavioral";
  }

  if (roleContext === "non_technical") {
    return "functional";
  }

  const normalizedSkill = normalizeText(skillName).toLowerCase();

  if (TECHNICAL_SKILL_PATTERN.test(normalizedSkill)) {
    return "technical";
  }

  return "functional";
}

export function buildEvaluationRubric(questionType: InterviewQuestionType) {
  switch (questionType) {
    case InterviewQuestionType.CODING:
      return "Evaluate correctness, optimization, syntax, complexity, and execution reasoning.";
    case InterviewQuestionType.SYSTEM_DESIGN:
      return "Evaluate scalability, tradeoffs, resilience, data flow, boundaries, and architecture maturity.";
    case InterviewQuestionType.BEHAVIORAL:
      return "Evaluate communication, ownership, emotional maturity, leadership, and STAR-style specificity.";
    case InterviewQuestionType.ARCHITECTURE:
      return "Evaluate strategic reasoning, governance, platform maturity, enterprise integration, and long-term risk handling.";
    case InterviewQuestionType.TROUBLESHOOTING:
      return "Evaluate debugging methodology, root-cause analysis quality, prioritization, and operational maturity.";
    case InterviewQuestionType.MCQ:
      return "Evaluate answer choice accuracy and whether the explanation supports the selected option.";
    case InterviewQuestionType.CASE_STUDY:
      return "Evaluate scenario analysis, structure, tradeoffs, stakeholder awareness, and decision quality.";
    case InterviewQuestionType.TECHNICAL_DISCUSSION:
    default:
      return "Evaluate technical depth, real-world experience, terminology, architecture understanding, measurable outcomes, and clarity.";
  }
}

export type AnswerEvaluationPlanInput = {
  /** interview_questions.question_type, or the session question kind. */
  storedQuestionType?: string | null;
  questionText?: string | null;
  sourceType?: string | null;
  skillName?: string | null;
  jobTitle?: string | null;
  jobDescription?: string | null;
  coreSkills?: Array<string | null | undefined> | null;
  /** interview_questions.reference_context.evaluation_criteria */
  evaluationCriteria?: string | null;
  /** interview_questions.reference_context.anchor (competency label) */
  competencyLabel?: string | null;
};

export type AnswerEvaluationPlan = {
  questionType: InterviewQuestionType;
  /** What the evaluator is told the question type is. */
  questionTypeLabel: string;
  roleContext: RoleContext;
  skillType: SkillType;
  rubric: string;
  rubricSource: "question_type" | "role_neutral";
  evaluationCriteria: string | null;
  competency: string | null;
};

export function resolveAnswerEvaluationPlan(input: AnswerEvaluationPlanInput): AnswerEvaluationPlan {
  // Question type resolution is unchanged from the previous inline logic, so
  // technical roles resolve exactly as before.
  const questionType = normalizeInterviewQuestionType(
    input.storedQuestionType,
    classifyInterviewQuestion(
      input.questionText ?? "",
      input.jobTitle ?? undefined,
      input.skillName ? [input.skillName] : []
    ).questionType
  );
  const roleContext = resolveRoleContext({
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    coreSkills: input.coreSkills,
  });
  const neutralise = roleContext.kind === "non_technical" && TECHNICAL_ONLY_TYPES.has(questionType);
  const criteria = normalizeText(input.evaluationCriteria).slice(0, MAX_CRITERIA_LENGTH);
  const competency = normalizeText(input.competencyLabel).slice(0, 120);

  return {
    questionType,
    questionTypeLabel: neutralise ? ROLE_NEUTRAL_QUESTION_TYPE_LABEL : questionType,
    roleContext,
    skillType: deriveSkillType(input.sourceType, input.skillName, questionType, roleContext.kind),
    rubric: neutralise ? ROLE_NEUTRAL_RUBRIC : buildEvaluationRubric(questionType),
    rubricSource: neutralise ? "role_neutral" : "question_type",
    evaluationCriteria: criteria || null,
    competency: competency || null,
  };
}
