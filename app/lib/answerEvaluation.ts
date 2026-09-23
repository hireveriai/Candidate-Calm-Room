import { openAiFetch } from "@/app/lib/aiUsageLog";
import { buildEvaluationRubric } from "@/app/lib/evaluationRubric";
import { InterviewQuestionType } from "@/app/lib/interviewQuestionTypes";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type BehaviorSignal = {
  type: string;
  severity?: "low" | "medium" | "high";
  meta?: JsonValue;
  timestamp?: number;
};

export type FocusMetrics = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
};

export type EvaluationResult = {
  skill_score: number;
  clarity_score: number;
  depth_score: number;
  confidence_score: number;
  fraud_score: number;
  reasoning: string;
  evaluation_json: JsonValue;
};

export function clamp01(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

// The rubric and skill-type logic lives in the pure evaluationRubric module so
// it can be unit tested without Prisma; re-exported here so existing imports
// keep working.
export {
  buildEvaluationRubric,
  deriveSkillType,
  resolveAnswerEvaluationPlan,
} from "@/app/lib/evaluationRubric";

// Shared by both the live per-answer evaluation route and the recording
// repair pipeline, so a recovered answer gets the exact same real AI
// judgment of its content as a normally captured one, instead of a
// placeholder that describes how the transcript was obtained.
export async function evaluateAnswerWithAi(input: {
  jobRole: string | null;
  skillName: string | null;
  skillType: string;
  questionText: string | null;
  transcript: string;
  rawTranscript: string | null;
  focusMetrics: FocusMetrics | null | undefined;
  behaviorSignals: BehaviorSignal[];
  questionType: InterviewQuestionType;
  /**
   * Role-aware rubric and label from resolveAnswerEvaluationPlan. When absent
   * the question-type rubric is used, which is the previous behaviour.
   */
  evaluationRubric?: string | null;
  questionTypeLabel?: string | null;
  /** The question's own stored evaluation criteria, when it has any. */
  evaluationCriteria?: string | null;
  competency?: string | null;
}) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const response = await openAiFetch("https://api.openai.com/v1/chat/completions", {
    aiUsage: { operation: "interview.answer_evaluation" },
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are evaluating a spoken interview answer.",
            "Return only JSON with keys skill_score, clarity_score, depth_score, confidence_score, integrity_risk, reasoning.",
            "All scores must be numbers between 0 and 1.",
            "Treat the transcript as imperfect automatic speech recognition with missing punctuation, substitutions, and possible question echo.",
            "Do not penalize accent, missing transcript punctuation, isolated grammar slips, non-native phrasing, or likely speech-to-text mistakes.",
            "Grammar may reduce clarity only when repeated candidate-origin sentence-structure problems remain after normalizing obvious transcription artifacts and materially obscure the intended meaning.",
            "Do not claim a grammar problem from one phrase. Require a recurring pattern within the answer and identify how it affected comprehension in the reasoning.",
            "Clarity should reflect whether the candidate's intended reasoning and sequence can be understood after mentally normalizing obvious transcription artifacts.",
            "Depth should reflect specificity, role-relevant detail (technical or functional, as the role requires), and authenticity.",
            "Judge the answer by the standards of the job_role. Do not expect software, engineering or other technical detail unless the job role or the question itself calls for it.",
            "When question_evaluation_criteria is provided, treat it as the primary description of a strong answer and use evaluation_rubric as secondary guidance.",
            "Confidence should reflect decisiveness, coherence, and delivery confidence, not arrogance.",
            "Call an answer vague only when it lacks concrete steps, decisions, examples, tools, or outcomes relevant to the question.",
            "Integrity risk must be based only on explicit contradictions or implausible content in the answer. Never infer it from grammar, accent, fluency, transcription quality, gaze, or delivery style.",
            "Integrity risk is a reviewer prompt, not an accusation. Never use the words fraud, dishonest, dishonesty, cheating, deception, or suspicious in the reasoning. Describe only the specific inconsistency you observed, and say nothing about integrity when there is none to report.",
            "Behavior and focus signals are scored separately and must not be included in these content scores.",
            "Use the question_type-specific rubric instead of assuming all technical questions are coding tasks.",
            "Do not inflate scores when the answer is vague.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              job_role: input.jobRole ?? "",
              skill: input.skillName ?? "",
              skill_type: input.skillType,
              question_type: input.questionTypeLabel || input.questionType,
              evaluation_rubric: input.evaluationRubric || buildEvaluationRubric(input.questionType),
              ...(input.evaluationCriteria
                ? { question_evaluation_criteria: input.evaluationCriteria }
                : {}),
              ...(input.competency ? { competency: input.competency } : {}),
              question: input.questionText ?? "",
              transcript: input.transcript,
              raw_transcript: input.rawTranscript ?? "",
              transcript_notice: "Automatic transcript; evaluate intended answer content rather than surface grammar.",
            },
            null,
            2
          ),
        },
      ],
    }),
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Answer evaluation failed: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Answer evaluation returned an empty response");
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Answer evaluation returned invalid JSON");
  }

  return {
    skill_score: clamp01(parsed.skill_score),
    clarity_score: clamp01(parsed.clarity_score),
    depth_score: clamp01(parsed.depth_score),
    confidence_score: clamp01(parsed.confidence_score),
    // The model is now asked for integrity_risk, because naming the field
    // "fraud" made it narrate about fraud and dishonesty in reasoning text that
    // recruiters read about named candidates. The internal field and the
    // database column keep their existing name so no reader has to change;
    // fraud_score is still accepted so evaluations already in flight parse.
    fraud_score: clamp01(parsed.integrity_risk ?? parsed.fraud_score),
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "AI evaluation completed.",
    evaluation_json: parsed as JsonValue,
  } satisfies EvaluationResult;
}
