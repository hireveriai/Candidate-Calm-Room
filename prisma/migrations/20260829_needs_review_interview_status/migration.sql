-- Interviews whose parent row claims COMPLETED while the attempt records a
-- platform-side failure.
--
-- finalizeInterviewAttempt wrote a literal status = 'COMPLETED', final_status =
-- 'FINALIZED' onto public.interviews regardless of the outcome it had just
-- computed, and markInterviewCompletedPendingTranscriptReview -- the explicit
-- "could not finalize" path -- wrote COMPLETED too. The attempt rows recorded
-- the truth the whole time; only the recruiter-facing interview row lied.
--
-- Both writers now derive the status (mapInterviewOutcome). This backfills the
-- rows written before that fix. It never touches an interview whose attempt
-- actually answered everything asked of it, and never downgrades a genuinely
-- finalized interview.

-- 1. Unrepaired transcripts. The attempt finished, but its answers never came
--    back from transcription, so there is no score to show and no verdict to
--    draw. Sweta Chauhan's session is one of these.
update public.interviews
set status = 'NEEDS_REVIEW'
where upper(coalesce(status, '')) = 'COMPLETED'
  and upper(coalesce(final_status, '')) = 'TRANSCRIPT_REVIEW_REQUIRED';

-- 2. Attempts that ended abandoned, timed out, or exited early while leaving
--    required questions unasked. Kawaljeet Kaur's session is one of these:
--    ABANDONED at 6 of 12 questions, surfaced as COMPLETED / FINALIZED.
with latest_attempt as (
  select distinct on (a.interview_id)
    a.interview_id,
    a.status,
    a.early_exit,
    a.questions_answered,
    a.expected_questions,
    a.completion_percentage
  from public.interview_attempts a
  order by a.interview_id, a.started_at desc nulls last
)
update public.interviews i
set status = 'NEEDS_REVIEW',
    final_status = case
      when upper(coalesce(la.status, '')) = 'TIME_EXPIRED' then 'TIME_EXPIRED'
      when upper(coalesce(la.status, '')) = 'ABANDONED' then 'ABANDONED'
      when upper(coalesce(la.status, '')) in ('FAILED', 'TERMINATED')
        then upper(la.status)
      else 'EARLY_EXIT'
    end
from latest_attempt la
where la.interview_id = i.interview_id
  and upper(coalesce(i.status, '')) = 'COMPLETED'
  -- Only outcomes that are not a completed interview.
  and (
    upper(coalesce(la.status, '')) in ('ABANDONED', 'TIME_EXPIRED', 'FAILED', 'TERMINATED')
    or la.early_exit is true
  )
  -- An attempt that answered everything asked of it is complete regardless of
  -- a stale status, and must keep its COMPLETED label.
  and not (
    coalesce(la.expected_questions, 0) > 0
    and coalesce(la.questions_answered, 0) >= la.expected_questions
  )
  and coalesce(la.completion_percentage, 0) < 1;
