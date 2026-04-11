import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type RouteContext = {
  params: Promise<{
    attemptId: string;
  }>;
};

type QuestionTimelineRow = {
  session_question_id: string;
  parent_session_question_id: string | null;
  question_order: number;
  question_kind: string | null;
  question: string;
  asked_at: Date | null;
  source_context: JsonValue | null;
  source: string | null;
  mapped_skill_id: string | null;
  mapped_skill_name: string | null;
  answer_id: string | null;
  answer_text: string | null;
  answer_payload: JsonValue | null;
  answered_at: Date | null;
  skill_score: string | number | null;
  clarity_score: string | number | null;
  depth_score: string | number | null;
  confidence_score: string | number | null;
  fraud_score: string | number | null;
  reasoning: string | null;
};

type InterviewSignalRecord = {
  signal_id: string;
  type: string;
  value: JsonValue;
  created_at: Date | null;
};

type FocusMetricsValue = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
  sessionQuestionId?: string;
};

type TimelineEntry = {
  timestamp: string | null;
  question: string;
  skill: string | null;
  reason_asked: string;
  answer_summary: string | null;
  evaluation: {
    skill_score: number | null;
    clarity_score: number | null;
    depth_score: number | null;
    confidence_score: number | null;
    fraud_score: number | null;
    why_score: string;
  };
  behavior: {
    signals: string[];
    focus: {
      focus_ratio: number | null;
      look_away_events: number;
      max_look_away_duration: number | null;
      assessment: string | null;
    } | null;
    interpretation: string;
  };
  system_decision: string;
};

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function asNumber(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asObject(value: JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, JsonValue>;
}

function asFocusMetrics(value: JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as FocusMetricsValue;
}

function extractTranscript(row: QuestionTimelineRow) {
  const payload = asObject(row.answer_payload);
  const cleaned = normalizeText(
    typeof payload?.cleaned_transcript === "string"
      ? payload.cleaned_transcript
      : null
  );

  if (cleaned) {
    return cleaned;
  }

  return normalizeText(row.answer_text);
}

function summarizeAnswer(text: string | null | undefined) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return null;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeText(sentence))
    .filter(Boolean);

  const summary = sentences.slice(0, 2).join(" ");
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function describeSourceType(sourceContext: JsonValue | null | undefined) {
  const context = asObject(sourceContext);
  const sourceType = normalizeText(
    typeof context?.source_type === "string" ? context.source_type : null
  ).toLowerCase();

  if (sourceType === "resume") {
    return "resume evidence";
  }

  if (sourceType === "job") {
    return "job requirement validation";
  }

  if (sourceType === "behavioral") {
    return "behavioral judgment";
  }

  return "interview coverage";
}

function buildReasonAsked(params: {
  row: QuestionTimelineRow;
  focusMetrics: FocusMetricsValue | null;
  priorCoveredSkills: Set<string>;
  parentRow: QuestionTimelineRow | undefined;
}) {
  const skill = params.row.mapped_skill_name;

  if (params.row.question_kind === "follow_up") {
    const parentTranscript = summarizeAnswer(
      params.parentRow ? extractTranscript(params.parentRow) : null
    );
    const parentSkillScore = asNumber(params.parentRow?.skill_score);
    const parentFraudScore = asNumber(params.parentRow?.fraud_score);

    if ((parentFraudScore ?? 0) >= 0.55) {
      return `This follow-up was triggered to verify authenticity on the same topic after elevated fraud risk was detected${skill ? ` for ${skill}` : ""}.`;
    }

    if ((parentSkillScore ?? 1) <= 0.55) {
      return `This follow-up was triggered to probe the same topic more deeply because the previous answer${skill ? ` on ${skill}` : ""} scored low or lacked specificity.`;
    }

    if ((params.focusMetrics?.focusRatio ?? 1) < 0.6) {
      return `This follow-up was kept on the same topic to confirm understanding after attention signals suggested a less stable response window.`;
    }

    return `This follow-up was asked to deepen the same topic and gather more concrete evidence${parentTranscript ? " from the previous response" : ""}.`;
  }

  if (skill && !params.priorCoveredSkills.has(params.row.mapped_skill_id ?? "")) {
    return `This question was asked to cover the required skill ${skill} as part of the interview plan.`;
  }

  if (skill) {
    return `This question was asked to continue validating ${skill} through ${describeSourceType(
      params.row.source_context
    )}.`;
  }

  return `This question was asked to advance ${describeSourceType(
    params.row.source_context
  )} and maintain interview coverage.`;
}

function buildScoreReason(row: QuestionTimelineRow) {
  const clarity = asNumber(row.clarity_score);
  const depth = asNumber(row.depth_score);
  const confidence = asNumber(row.confidence_score);
  const fraud = asNumber(row.fraud_score);
  const reasons: string[] = [];

  if (clarity !== null) {
    reasons.push(
      clarity >= 0.7
        ? "communication was clear"
        : clarity <= 0.45
          ? "communication was unclear"
          : "communication was moderately clear"
    );
  }

  if (depth !== null) {
    reasons.push(
      depth >= 0.7
        ? "the answer included strong detail"
        : depth <= 0.45
          ? "the answer lacked depth"
          : "the answer had moderate detail"
    );
  }

  if (confidence !== null) {
    reasons.push(
      confidence >= 0.7
        ? "delivery appeared confident"
        : confidence <= 0.45
          ? "delivery appeared uncertain"
          : "delivery appeared reasonably steady"
    );
  }

  if (fraud !== null && fraud >= 0.55) {
    reasons.push("behavioral or authenticity risk indicators were elevated");
  }

  if (!reasons.length) {
    return "No detailed score reasoning was available for this answer.";
  }

  return `${reasons[0].charAt(0).toUpperCase()}${reasons[0].slice(1)}${reasons.length > 1 ? `, and ${reasons.slice(1).join(", ")}` : ""}.`;
}

function buildBehaviorInterpretation(params: {
  signalTypes: string[];
  focusMetrics: FocusMetricsValue | null;
}) {
  const interpretations: string[] = [];

  if ((params.focusMetrics?.focusRatio ?? 1) < 0.6) {
    interpretations.push("attention was inconsistent during this answer");
  }

  if ((params.focusMetrics?.lookAwayEvents ?? 0) > 0) {
    interpretations.push("the candidate looked away multiple times");
  }

  if (params.signalTypes.includes("multi_face")) {
    interpretations.push("multiple-face detection introduced authenticity risk");
  }

  if (params.signalTypes.includes("tab_switch")) {
    interpretations.push("tab switching suggested potential distraction or policy risk");
  }

  if (params.signalTypes.includes("long_gaze_away")) {
    interpretations.push("extended gaze-away behavior suggested disengagement");
  }

  if (params.signalTypes.includes("attention_loss") && !interpretations.length) {
    interpretations.push("brief attention-loss events were detected");
  }

  if (!interpretations.length) {
    return "Behavioral signals were generally stable during this answer window.";
  }

  return `${interpretations[0].charAt(0).toUpperCase()}${interpretations[0].slice(1)}${interpretations.length > 1 ? `, and ${interpretations.slice(1).join(", ")}` : ""}.`;
}

function buildSystemDecision(params: {
  row: QuestionTimelineRow;
  nextRow: QuestionTimelineRow | undefined;
  signalTypes: string[];
  focusMetrics: FocusMetricsValue | null;
}) {
  const skillScore = asNumber(params.row.skill_score);
  const fraudScore = asNumber(params.row.fraud_score);

  if (!params.nextRow) {
    return "The system closed the interview flow after this step because there was no subsequent question in the session timeline.";
  }

  if (params.nextRow.question_kind === "follow_up") {
    if ((fraudScore ?? 0) >= 0.55) {
      return "The system triggered a follow-up to verify ownership and consistency on the same topic.";
    }

    if ((skillScore ?? 1) <= 0.55) {
      return "The system triggered a follow-up because the answer quality was not strong enough to move on confidently.";
    }

    return "The system triggered a follow-up to deepen the same topic before moving to a new skill area.";
  }

  if ((fraudScore ?? 0) >= 0.55) {
    return "Despite elevated risk indicators, the system moved to the next planned question rather than staying on the same topic.";
  }

  if ((params.focusMetrics?.focusRatio ?? 1) < 0.6 || params.signalTypes.includes("tab_switch")) {
    return "The system advanced while carrying forward behavioral risk context for later scoring.";
  }

  return "The system moved to the next planned question to continue skill coverage.";
}

export async function GET(_: Request, context: RouteContext) {
  try {
    const { attemptId } = await context.params;

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    const [rows, signals]: [QuestionTimelineRow[], InterviewSignalRecord[]] =
      await Promise.all([
        prisma.$queryRaw<QuestionTimelineRow[]>`
          select
            sq.session_question_id,
            sq.parent_session_question_id,
            sq.question_order,
            sq.question_kind,
            sq.content as question,
            sq.asked_at,
            sq.source_context,
            sq.source,
            sq.mapped_skill_id,
            sm.skill_name as mapped_skill_name,
            ia.answer_id,
            ia.answer_text,
            ia.answer_payload,
            ia.answered_at,
            iae.skill_score,
            iae.clarity_score,
            iae.depth_score,
            iae.confidence_score,
            iae.fraud_score,
            iae.feedback as reasoning
          from public.session_questions sq
          left join public.skill_master sm
            on sm.skill_id = sq.mapped_skill_id
          left join public.interview_answers ia
            on ia.session_question_id = sq.session_question_id
          left join public.interview_answer_evaluations iae
            on iae.answer_id = ia.answer_id
           and iae.evaluator_type = 'AI'
          where sq.attempt_id = ${attemptId}::uuid
          order by sq.question_order asc nulls last, sq.asked_at asc nulls last
        `,
        prisma.$queryRaw<InterviewSignalRecord[]>`
          select signal_id, type, value, created_at
          from public.interview_signals
          where attempt_id = ${attemptId}::uuid
          order by created_at asc
        `,
      ]);

    const rowById = new Map<string, QuestionTimelineRow>(
      rows.map((row: QuestionTimelineRow) => [row.session_question_id, row])
    );
    const coveredSkillIds = new Set<string>();

    const timeline: TimelineEntry[] = rows.map((row: QuestionTimelineRow, index: number) => {
      const nextRow = rows[index + 1];
      const parentRow = row.parent_session_question_id
        ? rowById.get(row.parent_session_question_id)
        : undefined;
      const questionAskedAt = row.asked_at
        ? new Date(row.asked_at).getTime()
        : Number.NEGATIVE_INFINITY;
      const nextQuestionAskedAt = nextRow?.asked_at
        ? new Date(nextRow.asked_at).getTime()
        : Number.POSITIVE_INFINITY;

      const rowSignals = signals.filter((signal: InterviewSignalRecord) => {
        const createdAt = signal.created_at
          ? new Date(signal.created_at).getTime()
          : Number.NEGATIVE_INFINITY;

        return createdAt >= questionAskedAt && createdAt < nextQuestionAskedAt;
      });

      const focusSignal = [...rowSignals]
        .reverse()
        .find((signal: InterviewSignalRecord) => signal.type === "focus_metrics");
      const focusMetrics = focusSignal ? asFocusMetrics(focusSignal.value) : null;
      const signalTypes = rowSignals.map((signal: InterviewSignalRecord) => signal.type);

      const reasonAsked = buildReasonAsked({
        row,
        focusMetrics,
        priorCoveredSkills: new Set(coveredSkillIds),
        parentRow,
      });

      if (row.mapped_skill_id) {
        coveredSkillIds.add(row.mapped_skill_id);
      }

      return {
        timestamp: row.asked_at ? new Date(row.asked_at).toISOString() : null,
        question: row.question,
        skill: row.mapped_skill_name,
        reason_asked: reasonAsked,
        answer_summary: summarizeAnswer(extractTranscript(row)),
        evaluation: {
          skill_score: asNumber(row.skill_score),
          clarity_score: asNumber(row.clarity_score),
          depth_score: asNumber(row.depth_score),
          confidence_score: asNumber(row.confidence_score),
          fraud_score: asNumber(row.fraud_score),
          why_score: buildScoreReason(row),
        },
        behavior: {
          signals: signalTypes,
          focus: focusMetrics
            ? {
                focus_ratio:
                  typeof focusMetrics.focusRatio === "number"
                    ? round(focusMetrics.focusRatio * 100)
                    : null,
                look_away_events: focusMetrics.lookAwayEvents ?? 0,
                max_look_away_duration:
                  typeof focusMetrics.maxLookAwayDuration === "number"
                    ? focusMetrics.maxLookAwayDuration
                    : null,
                assessment: focusMetrics.assessment ?? null,
              }
            : null,
          interpretation: buildBehaviorInterpretation({
            signalTypes,
            focusMetrics,
          }),
        },
        system_decision: buildSystemDecision({
          row,
          nextRow,
          signalTypes,
          focusMetrics,
        }),
      };
    });

    return Response.json({
      timeline,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build timeline reasoning";

    return Response.json({ error: message }, { status: 500 });
  }
}
