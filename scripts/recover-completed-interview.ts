import { config } from "dotenv";

config({ path: ".env" });
config({ path: ".env.local", override: true });

import { finalizeInterviewAttempt } from "../app/lib/interviewCompletion";
import { assertUuid } from "../app/lib/interviewReliability";
import { prisma } from "../app/lib/prisma";
import { validateAndRepairCompletionTranscripts } from "../app/lib/recordingTranscriptRepair";
import { markInterviewCompletedPendingTranscriptReview } from "../app/lib/completionPendingReview";

type AttemptAuditRow = {
  attempt_id: string;
  candidate_name: string;
  attempt_status: string | null;
  interview_status: string | null;
  final_status: string | null;
  transcript_status: string | null;
  answer_count: number;
  session_question_count: number;
  required_closing_count: number;
  answered_required_closing_count: number;
  generating_count: number;
  completed_count: number;
  non_empty_count: number;
  has_summary: boolean;
  has_attempt_score: boolean;
};

async function loadAttemptAudit(attemptId: string) {
  const rows = await prisma.$queryRaw<AttemptAuditRow[]>`
    select
      ia.attempt_id::text,
      c.full_name as candidate_name,
      ia.status as attempt_status,
      to_jsonb(i)->>'status' as interview_status,
      i.final_status,
      ia.transcript_status,
      count(ans.answer_id)::int as answer_count,
      (
        select count(*) from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
      )::int as session_question_count,
      (
        select count(*) from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
          and sq.question_kind = 'closing'
          and sq.source_context->>'required' = 'true'
      )::int as required_closing_count,
      (
        select count(*) from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
          and sq.question_kind = 'closing'
          and sq.source_context->>'required' = 'true'
          and exists (
            select 1 from public.interview_answers closing_answer
            where closing_answer.session_question_id = sq.session_question_id
          )
      )::int as answered_required_closing_count,
      count(ans.answer_id) filter (
        where upper(coalesce(ans.status, '')) = 'GENERATING'
      )::int as generating_count,
      count(ans.answer_id) filter (
        where upper(coalesce(ans.status, '')) = 'COMPLETED'
      )::int as completed_count,
      count(ans.answer_id) filter (
        where nullif(btrim(ans.answer_text), '') is not null
      )::int as non_empty_count,
      bool_or(summ.attempt_id is not null) as has_summary,
      bool_or(score.attempt_id is not null) as has_attempt_score
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    join public.candidates c
      on c.candidate_id = i.candidate_id
    left join public.interview_answers ans
      on ans.attempt_id = ia.attempt_id
    left join public.interview_summaries summ
      on summ.attempt_id = ia.attempt_id
    left join public.interview_attempt_scores score
      on score.attempt_id = ia.attempt_id
    where ia.attempt_id = ${attemptId}::uuid
    group by
      ia.attempt_id,
      c.full_name,
      ia.status,
      to_jsonb(i)->>'status',
      i.final_status,
      ia.transcript_status
  `;

  return rows[0] ?? null;
}

async function main() {
  const attemptId = assertUuid(process.argv[2], "attemptId");
  const apply = process.argv.includes("--apply");

  if (!apply) {
    throw new Error(
      "Recovery is mutation-capable. Re-run with an exact attempt UUID and --apply."
    );
  }

  const before = await loadAttemptAudit(attemptId);
  if (!before) {
    throw new Error("Interview attempt not found");
  }

  const transcriptIntegrity =
    await validateAndRepairCompletionTranscripts(attemptId);

  let finalized = false;
  let completedPendingTranscriptReview = false;
  if (transcriptIntegrity.remainingIssues === 0) {
    await finalizeInterviewAttempt({
      attemptId,
      earlyExit: false,
      terminationType: "completed",
      currentPhase: "closing",
      forceRecalculate: transcriptIntegrity.repairedAnswers > 0,
    });
    finalized = true;
  } else if (
    before.session_question_count > 0 &&
    before.answer_count >= before.session_question_count &&
    before.answered_required_closing_count >= before.required_closing_count
  ) {
    await prisma.$executeRaw`
      update public.interview_attempts
      set status = 'COMPLETING',
          termination_type = 'completed',
          early_exit = false,
          current_phase = 'closing',
          last_activity_at = now()
      where attempt_id = ${attemptId}::uuid
    `;
    await markInterviewCompletedPendingTranscriptReview({
      attemptId,
      transcriptIntegrity,
    });
    await prisma.$executeRaw`
      update public.interviews
      set status = 'COMPLETED',
          final_status = 'TRANSCRIPT_REVIEW_REQUIRED',
          failure_reason = null
      where interview_id = (
        select interview_id
        from public.interview_attempts
        where attempt_id = ${attemptId}::uuid
      )
    `;
    completedPendingTranscriptReview = true;
  }

  const after = await loadAttemptAudit(attemptId);
  console.log(
    JSON.stringify(
      {
        attemptId,
        candidate: before.candidate_name,
        transcriptIntegrity,
        finalized,
        completedPendingTranscriptReview,
        before,
        after,
      },
      null,
      2
    )
  );

  if (!finalized && !completedPendingTranscriptReview) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
