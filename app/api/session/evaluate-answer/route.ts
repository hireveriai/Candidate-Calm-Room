import { prisma } from "@/app/lib/prisma";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { assertUuid, logInterviewEvent } from "@/app/lib/interviewReliability";
import { InterviewQuestionType } from "@/app/lib/interviewQuestionTypes";
import { isInvalidCandidateTranscript } from "@/app/lib/transcriptGuards";
import {
  clamp01,
  evaluateAnswerWithAi,
  normalizeText,
  resolveAnswerEvaluationPlan,
  type BehaviorSignal,
  type EvaluationResult,
  type FocusMetrics,
} from "@/app/lib/answerEvaluation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  answerId?: string;
  sessionQuestionId?: string;
  transcript?: string;
  rawTranscript?: string;
  focusMetrics?: FocusMetrics | null;
  behaviorSignals?: BehaviorSignal[];
};

type QuestionContextRow = {
  answer_id: string;
  attempt_id: string;
  question_text: string | null;
  source_type: string | null;
  skill_id: string | null;
  skill_name: string | null;
  job_title: string | null;
  job_description?: string | null;
  core_skills?: string[] | null;
  question_type: string | null;
  question_kind: string | null;
  evaluation_criteria?: string | null;
  competency_label?: string | null;
};

function isMissingInterviewQuestionLinkColumn(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /interview_question_id/.test(message) && /does not exist/.test(message);
}

function hasMissingRecordEvaluationFunction(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes("record_answer_evaluation") &&
    error.message.includes("does not exist")
  );
}

function calculateBehaviorFraudAdjustment(params: {
  behaviorSignals: BehaviorSignal[];
  focusMetrics: FocusMetrics | null | undefined;
}) {
  const counts = {
    multi_face: 0,
    tab_switch: 0,
    long_gaze_away: 0,
    attention_loss: 0,
    no_face: 0,
  };

  for (const signal of params.behaviorSignals) {
    if (signal.type in counts) {
      counts[signal.type as keyof typeof counts] += 1;
    }
  }

  let adjustment = 0;

  adjustment += Math.min(counts.multi_face * 0.18, 0.36);
  adjustment += Math.min(counts.tab_switch * 0.12, 0.36);
  adjustment += Math.min(counts.long_gaze_away * 0.15, 0.3);
  adjustment += Math.min(counts.attention_loss * 0.04, 0.16);
  adjustment += Math.min(counts.no_face * 0.05, 0.15);

  const focusRatio = params.focusMetrics?.focusRatio ?? 1;
  const maxLookAwayDuration = params.focusMetrics?.maxLookAwayDuration ?? 0;
  const lookAwayEvents = params.focusMetrics?.lookAwayEvents ?? 0;

  if (focusRatio < 0.4) {
    adjustment += 0.18;
  } else if (focusRatio < 0.6) {
    adjustment += 0.08;
  }

  if (maxLookAwayDuration >= 8) {
    adjustment += 0.12;
  } else if (maxLookAwayDuration >= 4) {
    adjustment += 0.06;
  }

  adjustment += Math.min(lookAwayEvents * 0.04, 0.12);

  return clamp01(adjustment);
}

function fallbackEvaluation(params: {
  transcript: string;
  skillName: string | null;
  focusMetrics: FocusMetrics | null | undefined;
  behaviorSignals: BehaviorSignal[];
  questionType: InterviewQuestionType;
}) {
  const wordCount = normalizeText(params.transcript).split(/\s+/).filter(Boolean).length;
  const hasMetrics = /\b\d+(\.\d+)?%?\b/.test(params.transcript);
  const hasTools = Boolean(
    params.skillName &&
      new RegExp(`\\b${params.skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
        params.transcript
      )
  );
  const fraudAdjustment = calculateBehaviorFraudAdjustment({
    behaviorSignals: params.behaviorSignals,
    focusMetrics: params.focusMetrics,
  });

  const clarity =
    wordCount >= 60 ? 0.72 : wordCount >= 35 ? 0.62 : wordCount >= 20 ? 0.5 : 0.34;
  const depth =
    hasMetrics || hasTools ? 0.68 : wordCount >= 45 ? 0.58 : wordCount >= 25 ? 0.46 : 0.3;
  const confidence = clamp01(
    (params.focusMetrics?.focusRatio ?? 0.8) * 0.7 + (wordCount >= 25 ? 0.15 : 0)
  );
  const skill = clamp01((clarity * 0.45) + (depth * 0.55));

  return {
    skill_score: skill,
    clarity_score: clarity,
    depth_score: depth,
    confidence_score: confidence,
    fraud_score: clamp01(0.12 + fraudAdjustment),
    // This is displayed to recruiters as "VERIS Feedback", so it must read as
    // feedback on the answer, not an internal note about scoring internals —
    // the "how this was scored" detail belongs in evaluation_json.mode only.
    reasoning:
      "Automated scoring estimate based on the candidate's answer. Detailed AI feedback was unavailable for this response.",
    evaluation_json: {
      mode: "fallback",
      word_count: wordCount,
      fraud_adjustment: fraudAdjustment,
    },
  } satisfies EvaluationResult;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const {
      answerId,
      sessionQuestionId,
      transcript,
      rawTranscript,
      focusMetrics,
      behaviorSignals = [],
    } = body;

    if (!answerId || !sessionQuestionId || !transcript?.trim()) {
      return Response.json(
        { error: "answerId, sessionQuestionId, and transcript are required" },
        { status: 400 }
      );
    }

    assertUuid(answerId, "answerId");
    assertUuid(sessionQuestionId, "sessionQuestionId");

    // The planned question behind this answer. Questions snapshotted from a
    // job questionnaire have no question_id (public.questions is unused), so
    // matching on question_id alone never found them and scoring ran without
    // the question's source, type or stored evaluation criteria. The asked
    // session question records interview_question_id; that is the reliable
    // link. question_id is kept as a fallback for older interviews, and exact
    // text within the same interview for rows asked before the link existed.
    let contextRows: QuestionContextRow[];

    try {
      contextRows = await prisma.$queryRaw<QuestionContextRow[]>`
      select
        ia.answer_id,
        ia.attempt_id,
        sq.content as question_text,
        iq.source_type,
        coalesce(iq.target_skill_id, qsm.skill_id) as skill_id,
        sm.skill_name,
        jp.job_title,
        jp.job_description,
        jp.core_skills,
        coalesce(iq.question_type, sq.question_kind) as question_type,
        sq.question_kind,
        iq.reference_context->>'evaluation_criteria' as evaluation_criteria,
        iq.reference_context->>'anchor' as competency_label
      from public.interview_answers ia
      join public.session_questions sq
        on sq.session_question_id = ia.session_question_id
      join public.interview_attempts iat
        on iat.attempt_id = ia.attempt_id
      left join public.interviews i
        on i.interview_id = iat.interview_id
      left join public.job_positions jp
        on jp.job_id = i.job_id
      left join lateral (
        select candidate_iq.*
        from public.interview_questions candidate_iq
        where candidate_iq.interview_id = iat.interview_id
          and (
            candidate_iq.interview_question_id = sq.interview_question_id
            or (ia.question_id is not null and candidate_iq.question_id = ia.question_id)
            or (
              sq.interview_question_id is null
              and ia.question_id is null
              and sq.question_kind = 'core'
              and lower(btrim(candidate_iq.question_text)) = lower(btrim(sq.content))
            )
          )
        order by
          case
            when candidate_iq.interview_question_id = sq.interview_question_id then 0
            when candidate_iq.question_id = ia.question_id then 1
            else 2
          end,
          candidate_iq.question_order
        limit 1
      ) iq on true
      left join public.question_skill_map qsm
        on qsm.question_id = ia.question_id
      left join public.skill_master sm
        on sm.skill_id = coalesce(iq.target_skill_id, qsm.skill_id)
      where ia.answer_id = ${answerId}::uuid
        and ia.session_question_id = ${sessionQuestionId}::uuid
      limit 1
    `;
    } catch (linkedQueryError) {
      // Environments without session_questions.interview_question_id keep the
      // previous query rather than failing evaluation outright.
      if (!isMissingInterviewQuestionLinkColumn(linkedQueryError)) {
        throw linkedQueryError;
      }

      contextRows = await prisma.$queryRaw<QuestionContextRow[]>`
      select
        ia.answer_id,
        ia.attempt_id,
        sq.content as question_text,
        iq.source_type,
        coalesce(iq.target_skill_id, qsm.skill_id) as skill_id,
        sm.skill_name,
        jp.job_title,
        jp.job_description,
        jp.core_skills,
        coalesce(iq.question_type, sq.question_kind) as question_type,
        sq.question_kind,
        iq.reference_context->>'evaluation_criteria' as evaluation_criteria,
        iq.reference_context->>'anchor' as competency_label
      from public.interview_answers ia
      join public.session_questions sq
        on sq.session_question_id = ia.session_question_id
      join public.interview_attempts iat
        on iat.attempt_id = ia.attempt_id
      left join public.interviews i
        on i.interview_id = iat.interview_id
      left join public.job_positions jp
        on jp.job_id = i.job_id
      left join public.interview_questions iq
        on iq.interview_id = iat.interview_id
       and iq.question_id = ia.question_id
      left join public.question_skill_map qsm
        on qsm.question_id = ia.question_id
      left join public.skill_master sm
        on sm.skill_id = coalesce(iq.target_skill_id, qsm.skill_id)
      where ia.answer_id = ${answerId}::uuid
        and ia.session_question_id = ${sessionQuestionId}::uuid
      limit 1
    `;
    }

    const context = contextRows[0];

    if (!context) {
      return Response.json({ error: "Answer context not found" }, { status: 404 });
    }
    await requireCandidateSession(request, {
      attemptId: context.attempt_id,
      operation: "session.evaluate_answer",
    });

    if (context.question_kind === "closing") {
      logInterviewEvent("info", "answer.closing_response_recorded", {
        attemptId: context.attempt_id,
        state: "ANSWER_PROCESSING",
        nextState: "QUESTION_GENERATING",
        competencyImpact: "none",
      });
      return Response.json({
        answer_id: answerId,
        attempt_id: context.attempt_id,
        not_scored: true,
        competency_impact: "none",
        reason:
          "Motivation and candidate-closing responses are retained for recruiter review and excluded from competency scoring.",
      });
    }

    const evaluationPlan = resolveAnswerEvaluationPlan({
      storedQuestionType: context.question_type,
      questionText: context.question_text,
      sourceType: context.source_type,
      skillName: context.skill_name,
      jobTitle: context.job_title,
      jobDescription: context.job_description,
      coreSkills: context.core_skills,
      evaluationCriteria: context.evaluation_criteria,
      competencyLabel: context.competency_label,
    });
    const resolvedQuestionType = evaluationPlan.questionType;
    const skillType = evaluationPlan.skillType;
    const normalizedTranscript = normalizeText(transcript);
    const normalizedRawTranscript = normalizeText(rawTranscript);

    if (
      isInvalidCandidateTranscript({
        transcript: normalizedTranscript,
        questionText: context.question_text,
      })
    ) {
      return Response.json(
        { error: "Transcript contains interviewer prompt, not candidate answer" },
        { status: 422 }
      );
    }

    let evaluation =
      (await evaluateAnswerWithAi({
        jobRole: context.job_title,
        skillName: context.skill_name,
        skillType,
        questionText: context.question_text,
        transcript: normalizedTranscript,
        rawTranscript: normalizedRawTranscript || null,
        focusMetrics,
        behaviorSignals,
        questionType: resolvedQuestionType,
        questionTypeLabel: evaluationPlan.questionTypeLabel,
        evaluationRubric: evaluationPlan.rubric,
        evaluationCriteria: evaluationPlan.evaluationCriteria,
        competency: evaluationPlan.competency,
      }).catch((error) => {
        console.error("Spoken answer AI evaluation error:", error);
        return null;
      })) ??
      fallbackEvaluation({
        transcript: normalizedTranscript,
        skillName: context.skill_name,
        focusMetrics,
        behaviorSignals,
        questionType: resolvedQuestionType,
      });

    const behaviorFraudAdjustment = calculateBehaviorFraudAdjustment({
      behaviorSignals,
      focusMetrics,
    });
    const adjustedFraudScore = clamp01(
      evaluation.fraud_score + behaviorFraudAdjustment
    );

    evaluation = {
      ...evaluation,
      fraud_score: adjustedFraudScore,
      evaluation_json: {
        ...(typeof evaluation.evaluation_json === "object" &&
        evaluation.evaluation_json &&
        !Array.isArray(evaluation.evaluation_json)
          ? evaluation.evaluation_json
          : {}),
        signal_adjustment: {
          behavior_fraud_adjustment: behaviorFraudAdjustment,
          behavior_signals: behaviorSignals,
          focus_metrics: focusMetrics ?? null,
        },
        rubric_context: {
          role_context: evaluationPlan.roleContext.kind,
          role_family: evaluationPlan.roleContext.family,
          question_type: evaluationPlan.questionTypeLabel,
          rubric_source: evaluationPlan.rubricSource,
          evaluation_criteria_used: Boolean(evaluationPlan.evaluationCriteria),
        },
      },
    };

    try {
      await prisma.$queryRaw`
        select *
        from public.record_answer_evaluation(
          ${answerId}::uuid,
          ${evaluation.skill_score}::numeric,
          ${evaluation.clarity_score}::numeric,
          ${evaluation.depth_score}::numeric,
          ${evaluation.confidence_score}::numeric,
          ${evaluation.fraud_score}::numeric,
          ${evaluation.reasoning}::text,
          ${context.skill_id}::uuid,
          ${JSON.stringify(evaluation.evaluation_json)}::jsonb
        )
      `;
    } catch (error) {
      if (!hasMissingRecordEvaluationFunction(error)) {
        throw error;
      }

      await prisma.$executeRaw`
        insert into public.interview_answer_evaluations (
          answer_id,
          evaluator_type,
          score,
          feedback,
          evaluated_at
        )
        values (
          ${answerId}::uuid,
          ${"AI"}::text,
          ${evaluation.skill_score}::numeric,
          ${evaluation.reasoning}::text,
          now()
        )
        on conflict do nothing
      `;
    }

    logInterviewEvent("info", "answer.evaluated", {
      attemptId: context.attempt_id,
      aiLatencyMs: null,
      score: evaluation.skill_score,
      clarityScore: evaluation.clarity_score,
      confidenceScore: evaluation.confidence_score,
      fraudScore: evaluation.fraud_score,
    });

    return Response.json({
      answer_id: answerId,
      attempt_id: context.attempt_id,
      skill_id: context.skill_id,
      skill_name: context.skill_name,
      skill_type: skillType,
      ...evaluation,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to evaluate spoken answer";

    return Response.json({ error: message }, { status: 500 });
  }
}
