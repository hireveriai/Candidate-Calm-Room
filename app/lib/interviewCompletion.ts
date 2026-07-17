import { prisma } from "@/app/lib/prisma";
import { resolveEffectiveQuestionCount } from "@/app/lib/interviewBudget";
import { ensurePhase2SchemaCompatibility } from "@/app/lib/productionReadiness";
import {
  assertUuid,
  canTransitionInterviewState,
  isAttemptStatusFinalized,
  logInterviewEvent,
  normalizeInterviewState,
} from "@/app/lib/interviewReliability";
import { mapCompletionStatus } from "@/app/lib/interviewSessionReliability";
import {
  calculateInterviewScore,
  toFiniteNumber,
} from "@/app/lib/interviewScoring";

type TerminationType =
  | "completed"
  | "manual_exit"
  | "browser_close"
  | "tab_close"
  | "disconnect"
  | "timeout"
  | "watchdog_timeout"
  | "network_disconnect_timeout"
  | null;

type AttemptContextRow = {
  attempt_id: string;
  interview_id: string;
  organization_id: string | null;
  candidate_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  status: string;
  interview_status: string | null;
  expected_questions: number | null;
  question_count: number | null;
  duration_minutes: number | null;
  planned_question_count: number | null;
  completion_percentage: string | number | null;
  reliability_score: string | number | null;
  termination_type: string | null;
  termination_phase: string | null;
  early_exit: boolean | null;
  termination_metadata: unknown;
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

type TranscriptAggregateRow = {
  transcript_segments: number;
  transcript_events: number;
};

type SummaryAnswerEvidenceRow = {
  question_order: number | null;
  question: string | null;
  answer: string | null;
};

type SummaryTranscriptRow = {
  transcript: string | null;
};

type PersistedCompletionRow = {
  started_at: Date;
  ended_at: Date | null;
  termination_type: string | null;
  termination_phase: string | null;
  early_exit: boolean | null;
  questions_answered: number | null;
  completion_percentage: string | number | null;
  reliability_score: string | number | null;
  termination_metadata: unknown;
  hire_recommendation: string | null;
  strengths: string | null;
  weaknesses: string | null;
  risk_level: string | null;
  ai_summary: string | null;
};

type PrismaExecutor = typeof prisma;

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

function asNumber(value: unknown): number {
  return toFiniteNumber(value);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeFinalScore(score: number) {
  return clamp(round(score), 0, 100);
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

function normalizeSummaryText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function wordCount(value: string) {
  return normalizeSummaryText(value).split(/\s+/).filter(Boolean).length;
}

function clipWords(value: string, maxWords: number) {
  const words = normalizeSummaryText(value).split(/\s+/).filter(Boolean);
  return words.length <= maxWords
    ? words.join(" ")
    : `${words.slice(0, maxWords).join(" ")}...`;
}

function isSubstantiveAnswer(value: string | null | undefined) {
  const normalized = normalizeSummaryText(value).toLowerCase();
  return normalized && normalized !== "no response provided.";
}

async function loadSummaryAnswerEvidence(db: PrismaExecutor, attemptId: string) {
  const rows = await db.$queryRaw<SummaryAnswerEvidenceRow[]>`
    select
      sq.question_order,
      sq.content as question,
      coalesce(
        nullif(btrim(ans.answer_text), ''),
        nullif(btrim(cs.code_text), '')
      ) as answer
    from public.session_questions sq
    left join public.interview_answers ans
      on ans.session_question_id = sq.session_question_id
    left join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    where sq.attempt_id = ${attemptId}::uuid
    order by sq.question_order asc nulls last, sq.asked_at asc nulls last
  `;

  return rows
    .map((row: SummaryAnswerEvidenceRow) => ({
      questionOrder: row.question_order,
      question: normalizeSummaryText(row.question),
      answer: normalizeSummaryText(row.answer),
    }))
    .filter((row: { answer: string }) => isSubstantiveAnswer(row.answer));
}

async function loadRichestTranscript(db: PrismaExecutor, attemptId: string) {
  const rows = await db.$queryRaw<SummaryTranscriptRow[]>`
    select transcript
    from (
      select string_agg(ft.transcript, ' ' order by ft.segment_index asc) as transcript
      from public.forensic_transcripts ft
      where ft.attempt_id = ${attemptId}::uuid

      union all

      select ir.transcript
      from public.interview_recordings ir
      where ir.attempt_id = ${attemptId}::uuid
        and ir.transcript is not null
        and btrim(ir.transcript) <> ''
    ) sources
    where transcript is not null
      and btrim(transcript) <> ''
    order by char_length(transcript) desc
    limit 1
  `;

  return normalizeSummaryText(rows[0]?.transcript);
}

function buildEvidenceBasedSummary(params: {
  score: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  recommendation: string;
  reason: string;
  strengths: string[];
  weaknesses: string[];
  behavioralFlags: string[];
  questionsAnswered: number;
  expectedQuestions: number;
  transcript: string;
  answers: Array<{ questionOrder: number | null; question: string; answer: string }>;
}) {
  const answerWords = params.answers.reduce((total, answer) => total + wordCount(answer.answer), 0);
  const transcriptWords = wordCount(params.transcript);
  const evidenceWordCount = Math.max(answerWords, transcriptWords);
  const strongestAnswers = [...params.answers]
    .sort((left, right) => wordCount(right.answer) - wordCount(left.answer))
    .slice(0, 4);
  const answerHighlights = strongestAnswers.map((item) => {
    const prefix = item.questionOrder ? `Q${item.questionOrder}` : "Answer";
    const question = item.question ? ` (${clipWords(item.question, 10)})` : "";
    return `${prefix}${question}: ${clipWords(item.answer, 34)}`;
  });
  const transcriptHighlight =
    params.transcript && transcriptWords > answerWords + 25
      ? `Additional recording evidence: ${clipWords(params.transcript, 60)}`
      : null;
  const coverage = `${params.questionsAnswered}/${Math.max(params.expectedQuestions, params.questionsAnswered, 1)} questions`;

  return [
    `VERIS evaluated ${coverage} with about ${evidenceWordCount} words of candidate evidence. Final score: ${params.score}/100. Recommendation: ${params.recommendation}. Risk level: ${params.riskLevel}.`,
    `Overall assessment: ${params.reason}. Strengths observed: ${params.strengths.join(", ")}.`,
    params.weaknesses.length
      ? `Development areas or review points: ${params.weaknesses.join(", ")}.`
      : "No major capability gaps were isolated from the captured answer evidence.",
    params.behavioralFlags.length
      ? `Behavioral/integrity signals to review: ${params.behavioralFlags.join(", ")}.`
      : "No major behavioral integrity flags were detected in the finalized evidence.",
    answerHighlights.length
      ? `Candidate evidence highlights: ${answerHighlights.join(" | ")}.`
      : null,
    transcriptHighlight,
  ].filter(Boolean).join("\n\n");
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

async function loadScoreAggregates(db: PrismaExecutor, attemptId: string) {
  try {
    return await db.$queryRaw<ScoreAggregateRow[]>`
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

    return db.$queryRaw<ScoreAggregateRow[]>`
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadScoreAggregatesWithRetry(attemptId: string) {
  let aggregateRows = await loadScoreAggregates(prisma, attemptId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const aggregate = aggregateRows[0];
    const answeredQuestions = aggregate?.questions_answered ?? 0;
    const hasComputedScores =
      asNumber(aggregate?.avg_skill_score) > 0 ||
      asNumber(aggregate?.avg_cognitive_score) > 0 ||
      asNumber(aggregate?.avg_fraud_score) > 0;

    if (!answeredQuestions || hasComputedScores) {
      return aggregateRows;
    }

    await sleep(200 * (attempt + 1));
    aggregateRows = await loadScoreAggregates(prisma, attemptId);
  }

  return aggregateRows;
}

async function loadSignalTypes(db: PrismaExecutor, attemptId: string) {
  const rows = await db.$queryRaw<{ type: string }[]>`
    select type
    from public.interview_signals
    where attempt_id = ${attemptId}::uuid
    order by created_at asc
  `;

  return rows
    .map((row: { type: string }) => row.type?.trim().toLowerCase())
    .filter((type: string | undefined): type is string => Boolean(type));
}

async function loadTranscriptAggregates(db: PrismaExecutor, attemptId: string) {
  const rows = await db.$queryRaw<TranscriptAggregateRow[]>`
    select
      (
        select count(*)
        from public.forensic_transcripts ft
        where ft.attempt_id = ${attemptId}::uuid
      )::int as transcript_segments,
      (
        select
          count(*) filter (
            where ia.answer_text is not null
              and nullif(trim(ia.answer_text), '') is not null
          )
        from public.interview_answers ia
        where ia.attempt_id = ${attemptId}::uuid
      )::int as transcript_events
  `;

  return rows[0] ?? {
    transcript_segments: 0,
    transcript_events: 0,
  };
}

async function loadAttemptContext(
  db: PrismaExecutor,
  attemptId: string,
  lock = false
) {
  const lockClause = lock ? "for update" : "";
  const query = `
    select
      ia.attempt_id,
      ia.interview_id,
      i.organization_id::text,
      i.candidate_id::text,
      ia.started_at,
      ia.ended_at,
      ia.status,
      i.status as interview_status,
      i.question_count,
      i.duration_minutes,
      ia.completion_percentage,
      ia.reliability_score,
      ia.termination_type,
      ia.termination_phase,
      ia.early_exit,
      ia.termination_metadata,
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
    where ia.attempt_id = $1::uuid
    limit 1
    ${lockClause}
  `;

  const attempts = (await db.$queryRawUnsafe(
    query,
    attemptId
  )) as AttemptContextRow[];
  return attempts[0] ?? null;
}

async function loadLatestQuestion(db: PrismaExecutor, attemptId: string) {
  const latestQuestions = await db.$queryRaw<LatestQuestionRow[]>`
    select question_kind, content
    from public.session_questions
    where attempt_id = ${attemptId}::uuid
    order by question_order desc, asked_at desc nulls last
    limit 1
  `;

  return latestQuestions[0] ?? null;
}

function parseTerminationMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function hasDeterministicFinalizationMarker(metadata: Record<string, unknown>) {
  return (
    metadata["source_of_truth"] ===
      "persisted_answers_evaluations_transcripts_signals" &&
    metadata["scoring_version"] === "completion-weighted-v2" &&
    typeof metadata["finalized_at"] === "string"
  );
}

function splitSummaryField(value: string | null | undefined) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadPersistedCompletionResult(
  db: PrismaExecutor,
  attemptId: string
) {
  const rows = (await db.$queryRaw`
    select
      ia.started_at,
      ia.ended_at,
      ia.termination_type,
      ia.termination_phase,
      ia.early_exit,
      ia.questions_answered,
      ia.completion_percentage,
      ia.reliability_score,
      ia.termination_metadata,
      s.hire_recommendation,
      s.strengths,
      s.weaknesses,
      s.risk_level,
      e.ai_summary
    from public.interview_attempts ia
    left join public.interview_summaries s
      on s.attempt_id = ia.attempt_id
    left join public.interview_evaluations e
      on e.attempt_id = ia.attempt_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `) as PersistedCompletionRow[];

  const row = rows[0];

  if (!row) {
    throw new Error("Interview attempt not found");
  }

  const metadata = parseTerminationMetadata(row.termination_metadata);
  const score = normalizeFinalScore(
    asNumber(metadata["final_score"] as string | number | null | undefined)
  );
  const behavioralFlags = Array.isArray(metadata["behavioral_flags"])
    ? metadata["behavioral_flags"].filter(
        (flag): flag is string => typeof flag === "string"
      )
    : [];
  const strengths = ensureStrengths(splitSummaryField(row.strengths));
  const weaknesses = cleanWeaknesses(
    splitSummaryField(row.weaknesses),
    behavioralFlags
  );

  return {
    score,
    risk_level:
      row.risk_level === "HIGH" || row.risk_level === "MEDIUM"
        ? row.risk_level
        : "LOW",
    strengths,
    weaknesses,
    behavioral_flags: behavioralFlags,
    recommendation:
      (row.hire_recommendation as InterviewCompletionResult["recommendation"]) ??
      "REVIEW_REQUIRED",
    reason:
      row.ai_summary ||
      (typeof metadata["reason"] === "string" && metadata["reason"]) ||
      "Persisted completion result",
    completed: true as const,
    early_exit: Boolean(row.early_exit),
    termination_type: (row.termination_type as TerminationType) ?? null,
    time_elapsed: Math.max(
      0,
      Math.round(
        ((row.ended_at ?? new Date()).getTime() - new Date(row.started_at).getTime()) /
          1000
      )
    ),
    questions_answered: Math.max(row.questions_answered ?? 0, 0),
    current_phase: row.termination_phase ?? "closing",
    completion_percentage: round(asNumber(row.completion_percentage) * 100),
    reliability_score: round(asNumber(row.reliability_score)),
  } satisfies InterviewCompletionResult;
}

export async function finalizeInterviewAttempt(params: {
  attemptId: string;
  earlyExit: boolean;
  terminationType?: TerminationType;
  currentPhase?: string | null;
}) {
  const attemptId = assertUuid(params.attemptId, "attemptId");
  await ensurePhase2SchemaCompatibility();
  logInterviewEvent("info", "interview.completion_started", {
    attemptId,
    terminationType: params.terminationType ?? null,
    earlyExit: params.earlyExit,
  });

  return prisma.$transaction(async (tx: PrismaExecutor) => {
    const lockedAttempt = await loadAttemptContext(tx, attemptId, true);

    if (!lockedAttempt) {
      throw new Error("Interview attempt not found");
    }

    const existingMetadata = parseTerminationMetadata(
      lockedAttempt.termination_metadata
    );
    const repairingLegacyFinalization =
      isAttemptStatusFinalized(lockedAttempt.status) &&
      !hasDeterministicFinalizationMarker(existingMetadata);

    if (isAttemptStatusFinalized(lockedAttempt.status)) {
      if (repairingLegacyFinalization) {
        logInterviewEvent("warn", "interview.completion_repair_started", {
          attemptId,
          interviewId: lockedAttempt.interview_id,
          orgId: lockedAttempt.organization_id,
          candidateId: lockedAttempt.candidate_id,
          state: lockedAttempt.status,
          nextState: "FINALIZING",
        });
      } else {
      logInterviewEvent("info", "interview.completion_reused", {
        attemptId,
        interviewId: lockedAttempt.interview_id,
        orgId: lockedAttempt.organization_id,
        candidateId: lockedAttempt.candidate_id,
        state: lockedAttempt.status,
        nextState: "FINALIZED",
      });

        await tx.$executeRaw`
          update public.interviews
          set status = 'COMPLETED',
              final_status = 'FINALIZED'
          where interview_id = ${lockedAttempt.interview_id}::uuid
            and (
              status is distinct from 'COMPLETED'
              or final_status is distinct from 'FINALIZED'
            )
        `;

        return loadPersistedCompletionResult(tx, attemptId);
      }
    }

    const normalizedCurrentState = normalizeInterviewState(lockedAttempt.status);
    const completionAlreadyCommitted =
      normalizedCurrentState === "COMPLETING" ||
      normalizedCurrentState === "FINALIZING";
    const effectiveEarlyExit = completionAlreadyCommitted ? false : params.earlyExit;
    const effectiveTerminationType = completionAlreadyCommitted
      ? "completed"
      : params.terminationType ?? null;

    if (completionAlreadyCommitted && params.earlyExit) {
      logInterviewEvent("warn", "interview.late_termination_ignored", {
        attemptId,
        interviewId: lockedAttempt.interview_id,
        state: lockedAttempt.status,
        nextState: "FINALIZING",
        terminationType: params.terminationType ?? null,
      });
    }

    if (
      !repairingLegacyFinalization &&
      normalizedCurrentState !== "COMPLETING" &&
      !canTransitionInterviewState(normalizedCurrentState, "COMPLETING")
    ) {
      logInterviewEvent("warn", "interview.completion_invalid_transition", {
        attemptId,
        interviewId: lockedAttempt.interview_id,
        orgId: lockedAttempt.organization_id,
        candidateId: lockedAttempt.candidate_id,
        state: lockedAttempt.status,
        nextState: "COMPLETING",
      });
      throw new Error(
        `Cannot finalize interview from state ${lockedAttempt.status}`
      );
    }

    await tx.$executeRaw`
      update public.interview_attempts
      set status = 'COMPLETING',
          current_phase = coalesce(${params.currentPhase ?? null}::text, current_phase),
          termination_type = coalesce(${effectiveTerminationType}::text, termination_type)
      where attempt_id = ${attemptId}::uuid
    `;

    const aggregates = await loadScoreAggregatesWithRetry(attemptId);
    const firstAggregate = aggregates[0];
    const waitingForScores =
      (firstAggregate?.questions_answered ?? 0) > 0 &&
      asNumber(firstAggregate?.avg_skill_score) === 0 &&
      asNumber(firstAggregate?.avg_cognitive_score) === 0 &&
      asNumber(firstAggregate?.avg_fraud_score) === 0;

    if (waitingForScores) {
      logInterviewEvent("warn", "interview.completion_scores_not_ready", {
        attemptId,
        state: lockedAttempt.status,
        nextState: "FINALIZING",
      });
    }

    const [attempt, latestQuestion, transcriptAggregate, signalTypes] =
      await Promise.all([
        loadAttemptContext(tx, attemptId),
        loadLatestQuestion(tx, attemptId),
        loadTranscriptAggregates(tx, attemptId),
        loadSignalTypes(tx, attemptId),
      ]);

    if (!attempt) {
      throw new Error("Interview attempt not found");
    }

    const aggregate = aggregates[0] ?? {
      questions_answered: 0,
      asked_questions: 0,
      avg_skill_score: 0,
      avg_cognitive_score: 0,
      avg_clarity_score: 0,
      avg_depth_score: 0,
      avg_fraud_score: 0,
    };

    const expectedQuestions = resolveEffectiveQuestionCount({
      configuredCount: attempt.expected_questions ?? attempt.question_count,
      durationMinutes: attempt.duration_minutes,
      plannedQuestionCount: attempt.planned_question_count,
    });
    const questionsAnswered = Math.max(aggregate.questions_answered ?? 0, 0);
    const askedQuestions = Math.max(aggregate.asked_questions ?? 0, 0);
    const avgSkillScore = clamp(asNumber(aggregate.avg_skill_score), 0, 1);
    const avgCognitiveScore = clamp(asNumber(aggregate.avg_cognitive_score), 0, 1);
    const avgClarityScore = clamp(asNumber(aggregate.avg_clarity_score), 0, 1);
    const avgDepthScore = clamp(asNumber(aggregate.avg_depth_score), 0, 1);
    const avgFraudScore = clamp(asNumber(aggregate.avg_fraud_score), 0, 1);
    const transcriptCoverage = clamp(
      (Math.max(transcriptAggregate.transcript_segments, transcriptAggregate.transcript_events) || questionsAnswered) /
        Math.max(questionsAnswered, 1),
      0.85,
      1
    );
    const {
      completionPercentage,
      completionFactor,
      completionScoreCap,
      qualityScore,
      integrityMultiplier,
      baseScore,
      finalScore: calculatedFinalScore,
    } = calculateInterviewScore({
      questionsAnswered,
      expectedQuestions,
      avgSkillScore,
      avgCognitiveScore,
      avgFraudScore,
    });
    const finalScore = normalizeFinalScore(calculatedFinalScore);
    const reliabilityScore = round(
      clamp(
        completionFactor * 85 + transcriptCoverage * 15,
        0,
        100
      )
    );
    const endedAt = attempt.ended_at ?? new Date();
    const elapsedSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - new Date(attempt.started_at).getTime()) / 1000)
    );
    const currentPhase = derivePhase({
      currentPhase: params.currentPhase,
      latestQuestionKind: latestQuestion?.question_kind,
      completionPercentage,
      earlyExit: effectiveEarlyExit,
    });
    const riskFlags = getRiskFlags({
      terminationType: effectiveTerminationType,
      currentPhase,
      avgFraudScore,
      earlyExit: effectiveEarlyExit,
    });
    const rawEvents = [
      ...(effectiveTerminationType === "manual_exit" ? ["manual_exit"] : []),
      ...signalTypes,
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

    const recommendation = effectiveEarlyExit
      ? finalScore >= 40
        ? "REVIEW_REQUIRED"
        : "NO_HIRE"
      : getRecommendation(finalScore, riskLevel);
    const evaluationDecision =
      mapRecommendationToEvaluationDecision(recommendation);
    const reason = generateReason(
      finalScore,
      riskLevel,
      weaknesses,
      behavioralFlags
    );
    const [summaryAnswers, richestTranscript] = await Promise.all([
      loadSummaryAnswerEvidence(tx, attemptId),
      loadRichestTranscript(tx, attemptId),
    ]);
    const aiSummary = buildEvidenceBasedSummary({
      score: finalScore,
      riskLevel,
      recommendation,
      reason,
      strengths,
      weaknesses,
      behavioralFlags,
      questionsAnswered,
      expectedQuestions,
      transcript: richestTranscript,
      answers: summaryAnswers,
    });

    validateEvaluation({
      score: finalScore,
      strengths,
      recommendation,
      reason: aiSummary,
    });

    const completionStatus = mapCompletionStatus({
      earlyExit: effectiveEarlyExit,
      terminationType: effectiveTerminationType,
    });
    const transcriptIntegrity =
      existingMetadata["transcript_integrity"] &&
      typeof existingMetadata["transcript_integrity"] === "object" &&
      !Array.isArray(existingMetadata["transcript_integrity"])
        ? (existingMetadata["transcript_integrity"] as Record<string, unknown>)
        : null;
    const finalTranscriptStatus =
      transcriptIntegrity?.["status"] === "needs_review" ? "PARTIAL" : "FINALIZED";

    const aggregateAudit = {
      asked_questions: askedQuestions,
      questions_answered: questionsAnswered,
      avg_skill_score: round(avgSkillScore, 4),
      avg_cognitive_score: round(avgCognitiveScore, 4),
      avg_fraud_score: round(avgFraudScore, 4),
      transcript_segments: transcriptAggregate.transcript_segments,
      transcript_events: transcriptAggregate.transcript_events,
      transcript_coverage: round(transcriptCoverage, 4),
      completion_factor: completionFactor,
      completion_score_cap: completionScoreCap,
      quality_score: round(qualityScore),
      integrity_multiplier: round(integrityMultiplier, 4),
      base_score: baseScore,
      final_score: finalScore,
      risk_flags: riskFlags,
      risk_score: riskScore,
      risk_level: riskLevel,
      behavioral_flags: behavioralFlags,
      transcript_integrity: transcriptIntegrity,
      reason,
      ai_summary: aiSummary,
      source_of_truth: "persisted_answers_evaluations_transcripts_signals",
      scoring_version: "completion-weighted-v2",
      finalized_at: new Date().toISOString(),
    };

    await tx.$executeRaw`
      update public.interview_attempts
      set status = 'FINALIZING',
          ended_at = coalesce(ended_at, now()),
          termination_type = ${completionStatus.terminationType}::text,
          termination_detected_at = case
            when ${effectiveEarlyExit} then now()
            else termination_detected_at
          end,
          termination_phase = ${currentPhase}::text,
          time_elapsed_seconds = ${elapsedSeconds}::integer,
          questions_answered = ${questionsAnswered}::integer,
          expected_questions = ${expectedQuestions}::integer,
          completion_percentage = ${round(completionPercentage, 4)},
          reliability_score = ${reliabilityScore},
          early_exit = ${effectiveEarlyExit},
          last_activity_at = coalesce(last_activity_at, now()),
          transcript_status = ${finalTranscriptStatus}::text,
          recording_status = case
            when exists (
              select 1
              from public.interview_recordings ir
              where ir.attempt_id = ${attemptId}::uuid
                and ir.status = 'completed'
            ) then 'FINALIZED'
            when exists (
              select 1
              from public.interview_recordings ir
              where ir.attempt_id = ${attemptId}::uuid
                and ir.status = 'failed'
            ) then 'FAILED'
            else recording_status
          end,
          termination_metadata = ${JSON.stringify(aggregateAudit)}::jsonb
      where attempt_id = ${attemptId}::uuid
    `;

    await tx.$executeRaw`
      update public.interview_recordings
      set transcript = coalesce(
            nullif(btrim(transcript), ''),
            (
              select nullif(
                btrim(string_agg(ans.answer_text, E'\n\n' order by ans.answered_at asc nulls last)),
                ''
              )
              from public.interview_answers ans
              where ans.attempt_id = ${attemptId}::uuid
                and ans.answer_text is not null
                and btrim(ans.answer_text) <> ''
            )
          )
      where attempt_id = ${attemptId}::uuid
    `;

    await tx.$executeRaw`
      update public.interviews
      set status = 'COMPLETED',
          final_status = 'FINALIZED'
      where interview_id = ${attempt.interview_id}::uuid
    `;

    await tx.$executeRaw`
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

    await tx.$executeRaw`
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

    await tx.$executeRaw`
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
      ${evaluationDecision}::text,
      ${aiSummary}::text,
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

    const bestAttempts = await tx.$queryRaw<BestAttemptRow[]>`
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
      await tx.$executeRaw`
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

    await tx.$executeRaw`
      update public.interview_attempts
      set status = ${completionStatus.status}::text
      where attempt_id = ${attemptId}::uuid
    `;

    logInterviewEvent("info", "interview.completed", {
      attemptId,
      interviewId: attempt.interview_id,
      orgId: attempt.organization_id,
      candidateId: attempt.candidate_id,
      state: "FINALIZING",
      nextState: "FINALIZED",
      timerState: {
        elapsedSeconds,
        durationMinutes: attempt.duration_minutes,
      },
      score: finalScore,
      riskLevel,
      questionsAnswered,
      expectedQuestions,
      transcriptCoverage,
      aggregateAudit,
    });

    return {
      score: finalScore,
      risk_level: riskLevel,
      strengths,
      weaknesses,
      behavioral_flags: behavioralFlags,
      recommendation,
      reason,
      completed: true,
      early_exit: effectiveEarlyExit,
      termination_type: completionStatus.terminationType,
      time_elapsed: elapsedSeconds,
      questions_answered: questionsAnswered,
      current_phase: currentPhase,
      completion_percentage: round(completionPercentage * 100),
      reliability_score: reliabilityScore,
    } satisfies InterviewCompletionResult;
  });
}
