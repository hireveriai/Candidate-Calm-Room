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

type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout";

type RequestBody = {
  attemptId?: string;
  terminationType?: string;
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
  currentPhase?: string;
};

type AttemptContextRow = {
  attempt_id: string;
  interview_id: string;
  started_at: Date;
  ended_at: Date | null;
  status: string;
  expected_questions: number | null;
  completion_percentage: string | number | null;
  reliability_score: string | number | null;
  termination_type: string | null;
  termination_phase: string | null;
  early_exit: boolean | null;
};

type SessionQuestionRow = {
  session_question_id: string;
  attempt_id: string;
  question_id: string | null;
};

type ScoreAggregateRow = {
  questions_answered: number;
  asked_questions: number;
  avg_skill_score: string | number | null;
  avg_cognitive_score: string | number | null;
  avg_fraud_score: string | number | null;
};

type LatestQuestionRow = {
  question_kind: string | null;
  content: string | null;
};

type BestAttemptRow = {
  attempt_id: string;
  normalized_score: string | number | null;
};

type TerminationResponse = {
  completed: true;
  early_exit: true;
  termination_type: TerminationType;
  time_elapsed: number;
  questions_answered: number;
  current_phase: string;
  avg_skill_score: number;
  avg_cognitive_score: number;
  avg_fraud_score: number;
  completion_percentage: number;
  completion_factor: number;
  base_score: number;
  final_score: number;
  reliability_score: number;
  risk_flags: string[];
};

function asNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeTerminationType(value: string | undefined): TerminationType {
  switch (value) {
    case "manual_exit":
    case "tab_close":
    case "disconnect":
    case "timeout":
      return value;
    default:
      return "manual_exit";
  }
}

function normalizePhase(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (["warmup", "core", "probe", "closing"].includes(normalized)) {
    return normalized;
  }

  return null;
}

function getCompletionFactor(completionPercentage: number) {
  if (completionPercentage >= 0.8) return 1.0;
  if (completionPercentage >= 0.6) return 0.85;
  if (completionPercentage >= 0.4) return 0.7;
  if (completionPercentage >= 0.2) return 0.5;
  return 0.3;
}

function derivePhase(params: {
  currentPhase?: string;
  latestQuestionKind?: string | null;
  completionPercentage: number;
}) {
  const explicitPhase = normalizePhase(params.currentPhase);
  if (explicitPhase) {
    return explicitPhase;
  }

  if (params.latestQuestionKind === "follow_up") {
    return "probe";
  }

  if (params.completionPercentage < 0.25) {
    return "warmup";
  }

  if (params.completionPercentage >= 0.85) {
    return "closing";
  }

  return "core";
}

function getRiskFlags(params: {
  terminationType: TerminationType;
  currentPhase: string;
  avgFraudScore: number;
}) {
  const flags: string[] = [];

  if (params.currentPhase === "probe") {
    flags.push("EXIT_DURING_PROBE_PHASE");
  }

  if (
    (params.terminationType === "manual_exit" ||
      params.terminationType === "tab_close") &&
    params.currentPhase === "probe"
  ) {
    flags.push("BEHAVIORAL_EARLY_EXIT");
  }

  if (params.avgFraudScore >= 0.7) {
    flags.push("HIGH_FRAUD_RISK");
  }

  return flags;
}

async function parseBody(request: Request): Promise<RequestBody> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RequestBody;
  }

  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as RequestBody;
}

async function saveInFlightAnswer(params: {
  sessionQuestionId?: string;
  transcript?: string;
  duration?: number;
}) {
  const sessionQuestionId = params.sessionQuestionId?.trim();
  const transcript = params.transcript?.trim();

  if (!sessionQuestionId || !transcript) {
    return;
  }

  const sessionQuestions = await prisma.$queryRaw<SessionQuestionRow[]>`
    select session_question_id, attempt_id, question_id
    from public.session_questions
    where session_question_id = ${sessionQuestionId}::uuid
    limit 1
  `;

  const sessionQuestion = sessionQuestions[0];
  if (!sessionQuestion) {
    return;
  }

  const answerPayload =
    typeof params.duration === "number" && params.duration >= 0
      ? ({ duration: Math.round(params.duration) } satisfies JsonValue)
      : null;

  const existingAnswers = await prisma.$queryRaw<{ answer_id: string }[]>`
    select answer_id
    from public.interview_answers
    where session_question_id = ${sessionQuestionId}::uuid
    limit 1
  `;

  if (existingAnswers[0]?.answer_id) {
    await prisma.$executeRaw`
      update public.interview_answers
      set answer_text = ${transcript}::text,
          answer_payload = ${
            answerPayload ? JSON.stringify(answerPayload) : null
          }::jsonb,
          answered_at = now()
      where answer_id = ${existingAnswers[0].answer_id}::uuid
    `;
    return;
  }

  await prisma.$executeRaw`
    insert into public.interview_answers (
      attempt_id,
      question_id,
      answer_text,
      answer_payload,
      session_question_id
    )
    values (
      ${sessionQuestion.attempt_id}::uuid,
      ${sessionQuestion.question_id ?? null}::uuid,
      ${transcript}::text,
      ${answerPayload ? JSON.stringify(answerPayload) : null}::jsonb,
      ${sessionQuestionId}::uuid
    )
  `;
}

export async function POST(request: Request) {
  try {
    const body = await parseBody(request);
    const attemptId = body.attemptId?.trim();

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    const terminationType = normalizeTerminationType(body.terminationType);

    await saveInFlightAnswer({
      sessionQuestionId: body.sessionQuestionId,
      transcript: body.transcript,
      duration: body.duration,
    });

    const attempts = await prisma.$queryRaw<AttemptContextRow[]>`
      select
        ia.attempt_id,
        ia.interview_id,
        ia.started_at,
        ia.ended_at,
        ia.status,
        ia.completion_percentage,
        ia.reliability_score,
        ia.termination_type,
        ia.termination_phase,
        ia.early_exit,
        coalesce(
          ia.expected_questions,
          i.question_count,
          (
            select count(*)
            from public.interview_questions iq
            where iq.interview_id = ia.interview_id
          ),
          0
        )::int as expected_questions
      from public.interview_attempts ia
      join public.interviews i
        on i.interview_id = ia.interview_id
      where ia.attempt_id = ${attemptId}::uuid
      limit 1
    `;

    const attempt = attempts[0];

    if (!attempt) {
      return Response.json(
        { error: "Interview attempt not found" },
        { status: 404 }
      );
    }

    const [aggregates, latestQuestions] = await Promise.all([
      prisma.$queryRaw<ScoreAggregateRow[]>`
        select
          count(*) filter (
            where ia.answer_text is not null
              and nullif(trim(ia.answer_text), '') is not null
              and lower(trim(ia.answer_text)) <> 'no response provided.'
          )::int as questions_answered,
          (
            select count(*)
            from public.session_questions sq
            where sq.attempt_id = ${attemptId}::uuid
          )::int as asked_questions,
          coalesce(avg(iae.skill_score), 0) as avg_skill_score,
          coalesce(avg((coalesce(iae.clarity_score, 0) + coalesce(iae.depth_score, 0) + coalesce(iae.confidence_score, 0)) / 3.0), 0) as avg_cognitive_score,
          coalesce(avg(iae.fraud_score), 0) as avg_fraud_score
        from public.interview_answers ia
        left join public.interview_answer_evaluations iae
          on iae.answer_id = ia.answer_id
         and iae.evaluator_type = 'AI'
        where ia.attempt_id = ${attemptId}::uuid
      `,
      prisma.$queryRaw<LatestQuestionRow[]>`
        select question_kind, content
        from public.session_questions
        where attempt_id = ${attemptId}::uuid
        order by question_order desc, asked_at desc nulls last
        limit 1
      `,
    ]);

    const aggregate = aggregates[0] ?? {
      questions_answered: 0,
      asked_questions: 0,
      avg_skill_score: 0,
      avg_cognitive_score: 0,
      avg_fraud_score: 0,
    };
    const latestQuestion = latestQuestions[0];

    const expectedQuestions = Math.max(asNumber(attempt.expected_questions), 1);
    const questionsAnswered = Math.max(aggregate.questions_answered ?? 0, 0);
    const askedQuestions = Math.max(aggregate.asked_questions ?? 0, 0);
    const completionPercentage = clamp(questionsAnswered / expectedQuestions, 0, 1);
    const completionFactor = getCompletionFactor(completionPercentage);
    const avgSkillScore = clamp(asNumber(aggregate.avg_skill_score), 0, 1);
    const avgCognitiveScore = clamp(asNumber(aggregate.avg_cognitive_score), 0, 1);
    const avgFraudScore = clamp(asNumber(aggregate.avg_fraud_score), 0, 1);
    const baseScore = round(
      clamp(
        ((avgSkillScore * 0.45) + (avgCognitiveScore * 0.4) + ((1 - avgFraudScore) * 0.15)) *
          100,
        0,
        100
      )
    );
    const finalScore = round(baseScore * completionFactor);
    const reliabilityScore = round(completionFactor * 100);
    const elapsedSeconds = Math.max(
      0,
      Math.round(
        ((attempt.ended_at ?? new Date()).getTime() - new Date(attempt.started_at).getTime()) /
          1000
      )
    );
    const currentPhase = derivePhase({
      currentPhase: body.currentPhase,
      latestQuestionKind: latestQuestion?.question_kind,
      completionPercentage,
    });
    const riskFlags = getRiskFlags({
      terminationType,
      currentPhase,
      avgFraudScore,
    });

    await prisma.$executeRaw`
      update public.interview_attempts
      set status = 'completed',
          ended_at = coalesce(ended_at, now()),
          termination_type = ${terminationType}::text,
          termination_detected_at = now(),
          termination_phase = ${currentPhase}::text,
          time_elapsed_seconds = ${elapsedSeconds}::integer,
          questions_answered = ${questionsAnswered}::integer,
          expected_questions = ${expectedQuestions}::integer,
          completion_percentage = ${round(completionPercentage, 4)},
          reliability_score = ${reliabilityScore},
          early_exit = true,
          termination_metadata = jsonb_build_object(
            'asked_questions', ${askedQuestions},
            'avg_skill_score', ${round(avgSkillScore, 4)},
            'avg_cognitive_score', ${round(avgCognitiveScore, 4)},
            'avg_fraud_score', ${round(avgFraudScore, 4)},
            'completion_factor', ${completionFactor},
            'base_score', ${baseScore},
            'final_score', ${finalScore},
            'risk_flags', ${JSON.stringify(riskFlags)}::jsonb
          )
      where attempt_id = ${attemptId}::uuid
    `;

    await prisma.$executeRaw`
      insert into public.interview_attempt_scores (
        attempt_id,
        total_questions,
        evaluated_questions,
        raw_score,
        normalized_score,
        evaluated_by,
        evaluated_at,
        interview_id
      )
      values (
        ${attemptId}::uuid,
        ${expectedQuestions}::integer,
        ${questionsAnswered}::integer,
        ${round(baseScore / 100, 4)},
        ${finalScore},
        'SYSTEM_TERMINATION',
        now(),
        ${attempt.interview_id}::uuid
      )
      on conflict (attempt_id)
      do update
      set total_questions = excluded.total_questions,
          evaluated_questions = excluded.evaluated_questions,
          raw_score = excluded.raw_score,
          normalized_score = excluded.normalized_score,
          evaluated_by = excluded.evaluated_by,
          evaluated_at = excluded.evaluated_at,
          interview_id = excluded.interview_id
    `;

    await prisma.$executeRaw`
      insert into public.interview_summaries (
        attempt_id,
        overall_score,
        risk_level,
        strengths,
        weaknesses,
        hire_recommendation,
        created_at
      )
      values (
        ${attemptId}::uuid,
        ${Math.round(finalScore)}::integer,
        ${
          riskFlags.includes("EXIT_DURING_PROBE_PHASE") || avgFraudScore >= 0.7
            ? "HIGH"
            : avgFraudScore >= 0.5
              ? "MEDIUM"
              : "LOW"
        }::text,
        ${
          questionsAnswered > 0 && avgSkillScore >= 0.65 ? "partial demonstrated skill" : null
        }::text,
        ${`early exit (${terminationType})`}::text,
        ${
          finalScore >= 75 && completionPercentage >= 0.8
            ? "STRONG_HIRE"
            : finalScore >= 50
              ? "REVIEW_REQUIRED"
              : "NO_HIRE"
        }::text,
        now()
      )
      on conflict (attempt_id)
      do update
      set overall_score = excluded.overall_score,
          risk_level = excluded.risk_level,
          strengths = excluded.strengths,
          weaknesses = excluded.weaknesses,
          hire_recommendation = excluded.hire_recommendation,
          created_at = excluded.created_at
    `;

    await prisma.$executeRaw`
      insert into public.interview_evaluations (
        attempt_id,
        final_score,
        decision,
        ai_summary,
        created_at,
        is_locked
      )
      values (
        ${attemptId}::uuid,
        ${finalScore},
        ${finalScore >= 50 ? "REVIEW_REQUIRED" : "NO_HIRE"}::text,
        ${`Interview ended early via ${terminationType}. Score generated from partial responses.`}::text,
        now(),
        true
      )
      on conflict (attempt_id)
      do update
      set final_score = excluded.final_score,
          decision = excluded.decision,
          ai_summary = excluded.ai_summary,
          created_at = excluded.created_at,
          is_locked = excluded.is_locked
    `;

    const bestAttempts = await prisma.$queryRaw<BestAttemptRow[]>`
      select ias.attempt_id, ias.normalized_score
      from public.interview_attempt_scores ias
      join public.interview_attempts ia
        on ia.attempt_id = ias.attempt_id
      where ia.interview_id = ${attempt.interview_id}::uuid
      order by ias.normalized_score desc nulls last, ias.evaluated_at desc
      limit 1
    `;

    const bestAttempt = bestAttempts[0];

    if (bestAttempt) {
      await prisma.$executeRaw`
        insert into public.interview_results (
          interview_id,
          best_attempt_id,
          final_score,
          result_status,
          decided_at
        )
        values (
          ${attempt.interview_id}::uuid,
          ${bestAttempt.attempt_id}::uuid,
          ${asNumber(bestAttempt.normalized_score)},
          ${"IN_REVIEW"}::text,
          now()
        )
        on conflict (interview_id)
        do update
        set best_attempt_id = excluded.best_attempt_id,
            final_score = excluded.final_score,
            result_status = excluded.result_status,
            decided_at = excluded.decided_at
      `;
    }

    const response: TerminationResponse = {
      completed: true,
      early_exit: true,
      termination_type: terminationType,
      time_elapsed: elapsedSeconds,
      questions_answered: questionsAnswered,
      current_phase: currentPhase,
      avg_skill_score: round(avgSkillScore * 100),
      avg_cognitive_score: round(avgCognitiveScore * 100),
      avg_fraud_score: round(avgFraudScore * 100),
      completion_percentage: round(completionPercentage * 100),
      completion_factor: completionFactor,
      base_score: baseScore,
      final_score: finalScore,
      reliability_score: reliabilityScore,
      risk_flags: riskFlags,
    };

    return Response.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to terminate interview";

    return Response.json({ error: message }, { status: 500 });
  }
}
