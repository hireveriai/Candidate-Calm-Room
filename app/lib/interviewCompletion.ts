import { prisma } from "@/app/lib/prisma";
import { resolveEffectiveQuestionCount } from "@/app/lib/interviewBudget";

type TerminationType =
  | "manual_exit"
  | "tab_close"
  | "disconnect"
  | "timeout"
  | null;

type AttemptContextRow = {
  attempt_id: string;
  interview_id: string;
  started_at: Date;
  ended_at: Date | null;
  status: string;
  expected_questions: number | null;
  question_count: number | null;
  duration_minutes: number | null;
  planned_question_count: number | null;
  completion_percentage: string | number | null;
  reliability_score: string | number | null;
  termination_type: string | null;
  termination_phase: string | null;
  early_exit: boolean | null;
};

type ScoreAggregateRow = {
  questions_answered: number;
  asked_questions: number;
  avg_skill_score: string | number | null;
  avg_cognitive_score: string | number | null;
  avg_clarity_score: string | number | null;
  avg_depth_score: string | number | null;
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

export type InterviewCompletionResult = {
  score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  strengths: string[];
  weaknesses: string[];
  behavioral_flags: string[];
  recommendation:
    | "STRONG_HIRE"
    | "HIRE"
    | "HOLD"
    | "WEAK_CANDIDATE"
    | "NO_HIRE"
    | "REVIEW_REQUIRED"
    | "RISK";
  reason: string;
  completed: true;
  early_exit: boolean;
  termination_type: TerminationType;
  time_elapsed: number;
  questions_answered: number;
  current_phase: string;
  completion_percentage: number;
  reliability_score: number;
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

function normalizeScore(score: number) {
  const normalized = score <= 10 ? score * 10 : score;
  return clamp(round(normalized), 0, 100);
}

function getRiskLevel(riskScore: number): "LOW" | "MEDIUM" | "HIGH" {
  if (riskScore >= 15) return "HIGH";
  if (riskScore >= 8) return "MEDIUM";
  return "LOW";
}

function mapEvents(events: string[]) {
  const labelByEvent: Record<string, string> = {
    manual_exit: "Early exit",
    tab_switch: "Tab switching",
    silence: "Long silence",
    multi_voice: "Multiple voices",
  };

  const seen = new Set<string>();
  const flags: string[] = [];

  for (const event of events) {
    const normalized = event.trim().toLowerCase();
    const label = labelByEvent[normalized];
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    flags.push(label);
  }

  return flags;
}

function ensureStrengths(strengths: string[]) {
  const cleaned = strengths
    .map((item) => item.trim())
    .filter((item) => item && item !== "-");

  if (!cleaned.length) {
    return [
      "Basic communication clarity",
      "Attempted structured response",
    ];
  }

  if (cleaned.length === 1) {
    if (cleaned[0] !== "Basic communication clarity") {
      cleaned.push("Basic communication clarity");
    } else {
      cleaned.push("Attempted structured response");
    }
  }

  return cleaned.slice(0, 4);
}

function cleanWeaknesses(weaknesses: string[], behavioralFlags: string[]) {
  const eventTokens = new Set(
    [
      "manual_exit",
      "tab_switch",
      "silence",
      "multi_voice",
      ...behavioralFlags.map((flag) => flag.toLowerCase()),
    ]
  );

  return weaknesses
    .map((item) => item.trim())
    .filter(
      (item, index, all) =>
        item &&
        !eventTokens.has(item.toLowerCase()) &&
        all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) ===
          index
    );
}

function getRecommendation(
  score: number,
  riskLevel: "LOW" | "MEDIUM" | "HIGH"
):
  | "STRONG_HIRE"
  | "HIRE"
  | "HOLD"
  | "WEAK_CANDIDATE"
  | "NO_HIRE"
  | "REVIEW_REQUIRED"
  | "RISK" {
  if (riskLevel === "HIGH") return "RISK";

  if (score >= 75) {
    if (riskLevel === "LOW") return "STRONG_HIRE";
    if (riskLevel === "MEDIUM") return "HIRE";
  }

  if (score >= 60) {
    if (riskLevel === "LOW") return "HIRE";
    if (riskLevel === "MEDIUM") return "HOLD";
  }

  if (score >= 40) {
    return "HOLD";
  }

  if (score < 40) {
    if (riskLevel === "LOW") return "WEAK_CANDIDATE";
    return "NO_HIRE";
  }

  return "REVIEW_REQUIRED";
}

function mapRecommendationToEvaluationDecision(
  recommendation:
    | "STRONG_HIRE"
    | "HIRE"
    | "HOLD"
    | "WEAK_CANDIDATE"
    | "NO_HIRE"
    | "REVIEW_REQUIRED"
    | "RISK"
): "HIRE" | "REVIEW" | "REJECT" {
  switch (recommendation) {
    case "STRONG_HIRE":
    case "HIRE":
      return "HIRE";
    case "NO_HIRE":
      return "REJECT";
    case "HOLD":
    case "WEAK_CANDIDATE":
    case "REVIEW_REQUIRED":
    case "RISK":
    default:
      return "REVIEW";
  }
}

function generateReason(
  score: number,
  riskLevel: "LOW" | "MEDIUM" | "HIGH",
  weaknesses: string[],
  flags: string[]
) {
  void weaknesses;
  void flags;

  if (riskLevel === "HIGH") {
    return "High risk signals detected including behavioral inconsistencies";
  }

  if (score >= 75) {
    return "Strong capability with consistent behavioral signals";
  }

  if (score >= 60) {
    return "Good performance with minor gaps in depth or clarity";
  }

  if (score >= 40) {
    return "Moderate performance with noticeable gaps in capability";
  }

  return "Insufficient capability demonstrated despite stable behavior";
}

function validateEvaluation(result: {
  score: number;
  strengths: string[];
  recommendation: string;
  reason: string;
}) {
  if (result.score < 0 || result.score > 100) {
    throw new Error("Final score must be within 0-100");
  }

  if (!result.strengths.length) {
    throw new Error("Final strengths cannot be empty");
  }

  if (!result.recommendation) {
    throw new Error("Final recommendation is required");
  }

  if (!result.reason) {
    throw new Error("Final reason is required");
  }
}

function hasMissingDatabaseColumnError(
  error: unknown,
  columnNames: string[] = []
) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const isMissingColumnError =
    message.includes("raw query failed") &&
    message.includes("column") &&
    message.includes("does not exist");

  if (!isMissingColumnError) {
    return false;
  }

  if (!columnNames.length) {
    return true;
  }

  return columnNames.some((columnName) =>
    message.includes(columnName.toLowerCase())
  );
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
  currentPhase?: string | null;
  latestQuestionKind?: string | null;
  completionPercentage: number;
  earlyExit: boolean;
}) {
  const explicitPhase = normalizePhase(params.currentPhase);
  if (explicitPhase) {
    return explicitPhase;
  }

  if (!params.earlyExit) {
    return "closing";
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
  earlyExit: boolean;
}) {
  const flags: string[] = [];

  if (params.earlyExit && params.currentPhase === "probe") {
    flags.push("EXIT_DURING_PROBE_PHASE");
  }

  if (
    params.earlyExit &&
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

async function loadScoreAggregates(attemptId: string) {
  try {
    return await prisma.$queryRaw<ScoreAggregateRow[]>`
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
        coalesce(avg(iae.clarity_score), 0) as avg_clarity_score,
        coalesce(avg(iae.depth_score), 0) as avg_depth_score,
        coalesce(avg(iae.fraud_score), 0) as avg_fraud_score
      from public.interview_answers ia
      left join public.interview_answer_evaluations iae
        on iae.answer_id = ia.answer_id
       and iae.evaluator_type = 'AI'
      where ia.attempt_id = ${attemptId}::uuid
    `;
  } catch (error) {
    if (
      !hasMissingDatabaseColumnError(error, [
        "skill_score",
        "clarity_score",
        "depth_score",
        "confidence_score",
        "fraud_score",
      ])
    ) {
      throw error;
    }

    return prisma.$queryRaw<ScoreAggregateRow[]>`
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
        coalesce(avg(iae.score), 0) as avg_skill_score,
        coalesce(avg(iae.score), 0) as avg_cognitive_score,
        coalesce(avg(iae.score), 0) as avg_clarity_score,
        coalesce(avg(iae.score), 0) as avg_depth_score,
        0::numeric as avg_fraud_score
      from public.interview_answers ia
      left join public.interview_answer_evaluations iae
        on iae.answer_id = ia.answer_id
       and iae.evaluator_type = 'AI'
      where ia.attempt_id = ${attemptId}::uuid
    `;
  }
}

async function loadSignalTypes(attemptId: string) {
  const rows = await prisma.$queryRaw<{ type: string }[]>`
    select type
    from public.interview_signals
    where attempt_id = ${attemptId}::uuid
    order by created_at asc
  `;

  return rows
    .map((row: { type: string }) => row.type?.trim().toLowerCase())
    .filter((type: string | undefined): type is string => Boolean(type));
}

export async function finalizeInterviewAttempt(params: {
  attemptId: string;
  earlyExit: boolean;
  terminationType?: TerminationType;
  currentPhase?: string | null;
}) {
  const attempts = await prisma.$queryRaw<AttemptContextRow[]>`
    select
      ia.attempt_id,
      ia.interview_id,
      ia.started_at,
      ia.ended_at,
      ia.status,
      i.question_count,
      i.duration_minutes,
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
        )::int,
        0
      )::int as expected_questions,
      (
        select count(*)
        from public.interview_questions iq
        where iq.interview_id = ia.interview_id
      )::int as planned_question_count
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    where ia.attempt_id = ${params.attemptId}::uuid
    limit 1
  `;

  const attempt = attempts[0];

  if (!attempt) {
    throw new Error("Interview attempt not found");
  }

  const [aggregates, latestQuestions] = await Promise.all([
    loadScoreAggregates(params.attemptId),
    prisma.$queryRaw<LatestQuestionRow[]>`
      select question_kind, content
      from public.session_questions
      where attempt_id = ${params.attemptId}::uuid
      order by question_order desc, asked_at desc nulls last
      limit 1
    `,
  ]);

  const aggregate = aggregates[0] ?? {
    questions_answered: 0,
    asked_questions: 0,
    avg_skill_score: 0,
    avg_cognitive_score: 0,
    avg_clarity_score: 0,
    avg_depth_score: 0,
    avg_fraud_score: 0,
  };
  const latestQuestion = latestQuestions[0];

  const expectedQuestions = resolveEffectiveQuestionCount({
    configuredCount: attempt.expected_questions ?? attempt.question_count,
    durationMinutes: attempt.duration_minutes,
    plannedQuestionCount: attempt.planned_question_count,
  });
  const questionsAnswered = Math.max(aggregate.questions_answered ?? 0, 0);
  const askedQuestions = Math.max(aggregate.asked_questions ?? 0, 0);
  const completionPercentage = clamp(questionsAnswered / Math.max(expectedQuestions, 1), 0, 1);
  const completionFactor = getCompletionFactor(completionPercentage);
  const avgSkillScore = clamp(asNumber(aggregate.avg_skill_score), 0, 1);
  const avgCognitiveScore = clamp(asNumber(aggregate.avg_cognitive_score), 0, 1);
  const avgClarityScore = clamp(asNumber(aggregate.avg_clarity_score), 0, 1);
  const avgDepthScore = clamp(asNumber(aggregate.avg_depth_score), 0, 1);
  const avgFraudScore = clamp(asNumber(aggregate.avg_fraud_score), 0, 1);
  const baseScore = round(
    clamp(
      ((avgSkillScore * 0.45) + (avgCognitiveScore * 0.4) + ((1 - avgFraudScore) * 0.15)) * 100,
      0,
      100
    )
  );
  const finalScore = normalizeScore(baseScore * completionFactor);
  const reliabilityScore = round(completionFactor * 100);
  const elapsedSeconds = Math.max(
    0,
    Math.round(((attempt.ended_at ?? new Date()).getTime() - new Date(attempt.started_at).getTime()) / 1000)
  );
  const currentPhase = derivePhase({
    currentPhase: params.currentPhase,
    latestQuestionKind: latestQuestion?.question_kind,
    completionPercentage,
    earlyExit: params.earlyExit,
  });
  const riskFlags = getRiskFlags({
    terminationType: params.terminationType ?? null,
    currentPhase,
    avgFraudScore,
    earlyExit: params.earlyExit,
  });
  const rawEvents = [
    ...(params.terminationType === "manual_exit" ? ["manual_exit"] : []),
    ...(await loadSignalTypes(params.attemptId)),
  ];
  const behavioralFlags = mapEvents(rawEvents);
  const riskScore = clamp(
    Math.round(
      avgFraudScore * 20 +
        (behavioralFlags.includes("Early exit") ? 4 : 0) +
        (behavioralFlags.includes("Tab switching") ? 5 : 0) +
        (behavioralFlags.includes("Long silence") ? 3 : 0) +
        (behavioralFlags.includes("Multiple voices") ? 6 : 0)
    ),
    0,
    20
  );
  const riskLevel = getRiskLevel(riskScore);

  const strengths = ensureStrengths(
    [
      avgSkillScore >= 0.7 ? "Demonstrated relevant capability" : "",
      avgClarityScore >= 0.65 ? "Basic communication clarity" : "",
      avgDepthScore >= 0.65 ? "Attempted structured response" : "",
      avgCognitiveScore >= 0.7 ? "Consistent response organization" : "",
    ].filter(Boolean)
  );

  const weaknesses = cleanWeaknesses(
    [
      avgDepthScore < 0.55 ? "lack of depth" : "",
      avgClarityScore < 0.55 ? "unclear answers" : "",
      avgSkillScore < 0.55 ? "weak problem solving" : "",
    ].filter(Boolean),
    behavioralFlags
  );

  const recommendation = getRecommendation(finalScore, riskLevel);
  const evaluationDecision =
    mapRecommendationToEvaluationDecision(recommendation);
  const reason = generateReason(
    finalScore,
    riskLevel,
    weaknesses,
    behavioralFlags
  );

  validateEvaluation({
    score: finalScore,
    strengths,
    recommendation,
    reason,
  });

  await prisma.$executeRaw`
    update public.interview_attempts
    set status = 'completed',
        ended_at = coalesce(ended_at, now()),
        termination_type = ${params.terminationType ?? null}::text,
        termination_detected_at = case
          when ${params.earlyExit} then now()
          else null
        end,
        termination_phase = ${currentPhase}::text,
        time_elapsed_seconds = ${elapsedSeconds}::integer,
        questions_answered = ${questionsAnswered}::integer,
        expected_questions = ${expectedQuestions}::integer,
        completion_percentage = ${round(completionPercentage, 4)},
        reliability_score = ${reliabilityScore},
        early_exit = ${params.earlyExit},
        termination_metadata = jsonb_build_object(
          'asked_questions', ${askedQuestions}::integer,
          'avg_skill_score', ${round(avgSkillScore, 4)}::numeric,
          'avg_cognitive_score', ${round(avgCognitiveScore, 4)}::numeric,
          'avg_fraud_score', ${round(avgFraudScore, 4)}::numeric,
          'completion_factor', ${completionFactor}::numeric,
          'base_score', ${baseScore}::numeric,
          'final_score', ${finalScore}::numeric,
          'risk_flags', ${JSON.stringify(riskFlags)}::jsonb,
          'risk_score', ${riskScore}::integer,
          'risk_level', ${riskLevel}::text,
          'behavioral_flags', ${JSON.stringify(behavioralFlags)}::jsonb,
          'reason', ${reason}::text
        )
    where attempt_id = ${params.attemptId}::uuid
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
      ${params.attemptId}::uuid,
      ${expectedQuestions}::integer,
      ${questionsAnswered}::integer,
      ${round(baseScore / 100, 4)},
      ${finalScore},
      ${"AI"}::text,
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
      ${params.attemptId}::uuid,
      ${Math.round(finalScore)}::integer,
      ${riskLevel}::text,
      ${strengths.join(", ")}::text,
      ${weaknesses.join(", ")}::text,
      ${recommendation}::text,
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
      ${params.attemptId}::uuid,
      ${finalScore},
      ${evaluationDecision}::text,
      ${reason}::text,
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

  return {
    score: finalScore,
    risk_level: riskLevel,
    strengths,
    weaknesses,
    behavioral_flags: behavioralFlags,
    recommendation,
    reason,
    completed: true,
    early_exit: params.earlyExit,
    termination_type: params.terminationType ?? null,
    time_elapsed: elapsedSeconds,
    questions_answered: questionsAnswered,
    current_phase: currentPhase,
    completion_percentage: round(completionPercentage * 100),
    reliability_score: reliabilityScore,
  } satisfies InterviewCompletionResult;
}
