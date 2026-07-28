import {
  hasCompletionEvidence,
  type CompletionEvidence,
} from "@/app/lib/completionTranscriptPolicy";
import { prisma } from "@/app/lib/prisma";

export async function loadInterviewCompletionEvidence(
  attemptId: string
): Promise<CompletionEvidence | null> {
  const rows = await prisma.$queryRaw<CompletionEvidence[]>`
    select
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
        from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
      )::int as session_questions,
      (
        select count(*)
        from public.interview_answers ans
        where ans.attempt_id = ia.attempt_id
      )::int as answer_rows,
      (
        select count(*)
        from public.interview_answers ans
        where ans.attempt_id = ia.attempt_id
          and nullif(trim(coalesce(ans.answer_text, '')), '') is not null
          and lower(trim(ans.answer_text)) <> 'no response provided.'
      )::int as non_empty_answers,
      (
        select count(*)
        from public.interview_answers ans
        where ans.attempt_id = ia.attempt_id
          and (
            (
              nullif(trim(coalesce(ans.answer_text, '')), '') is not null
              and lower(trim(ans.answer_text)) <> 'no response provided.'
            )
            or (
              lower(coalesce(ans.answer_payload->>'transcription_pending', 'false')) = 'true'
              and lower(coalesce(ans.answer_payload->>'voice_activity_detected', 'false')) = 'true'
              and lower(coalesce(ans.answer_payload->>'media_recorder_supported', 'false')) = 'true'
            )
          )
      )::int as captured_answer_rows,
      (
        select count(*)
        from public.interview_recordings ir
        where ir.attempt_id = ia.attempt_id
          and lower(coalesce(ir.status, '')) = 'completed'
          and nullif(
            trim(coalesce(ir.file_path, ir.audio_url, ir.video_url, '')),
            ''
          ) is not null
      )::int as completed_recordings,
      (
        select count(*)
        from public.interview_recordings ir
        where ir.attempt_id = ia.attempt_id
          and lower(coalesce(ir.status, 'recording')) in ('recording', 'completed')
          and (
            nullif(
              trim(coalesce(ir.file_path, ir.audio_url, ir.video_url, '')),
              ''
            ) is not null
            or nullif(trim(coalesce(ir.egress_id, '')), '') is not null
          )
      )::int as recording_evidence_rows,
      (
        select count(*)
        from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
          and sq.question_kind = 'closing'
          and sq.source_context->>'required' = 'true'
      )::int as required_closing_questions,
      (
        select count(*)
        from public.session_questions sq
        where sq.attempt_id = ia.attempt_id
          and sq.question_kind = 'closing'
          and sq.source_context->>'required' = 'true'
          and exists (
            select 1
            from public.interview_answers ans
            where ans.session_question_id = sq.session_question_id
              and (
                nullif(trim(coalesce(ans.answer_text, '')), '') is not null
                or (
                  lower(coalesce(ans.answer_payload->>'transcription_pending', 'false')) = 'true'
                  and lower(coalesce(ans.answer_payload->>'voice_activity_detected', 'false')) = 'true'
                  and lower(coalesce(ans.answer_payload->>'media_recorder_supported', 'false')) = 'true'
                )
              )
          )
      )::int as answered_required_closing_questions
    from public.interview_attempts ia
    join public.interviews i
      on i.interview_id = ia.interview_id
    where ia.attempt_id = ${attemptId}::uuid
    limit 1
  `;

  return rows[0] ?? null;
}

export async function getInterviewCompletionEligibility(attemptId: string) {
  const evidence = await loadInterviewCompletionEvidence(attemptId);

  return {
    eligible: hasCompletionEvidence(evidence),
    evidence,
  };
}
