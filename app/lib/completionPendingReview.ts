import { prisma } from "./prisma";

export async function markInterviewCompletedPendingTranscriptReview(params: {
  attemptId: string;
  transcriptIntegrity: unknown;
}) {
  await prisma.$transaction(async (tx: typeof prisma) => {
    const rows = await tx.$queryRaw<Array<{ interview_id: string }>>`
      update public.interview_attempts
      set status = 'COMPLETED',
          ended_at = coalesce(ended_at, now()),
          current_phase = 'closing',
          termination_type = 'completed',
          early_exit = false,
          transcript_status = 'PARTIAL',
          last_activity_at = now(),
          termination_metadata = jsonb_set(
            coalesce(termination_metadata, '{}'::jsonb),
            '{transcript_integrity}',
            ${JSON.stringify(params.transcriptIntegrity ?? {
              status: "needs_review",
              reason: "transcript_repair_unavailable",
            })}::jsonb,
            true
          )
      where attempt_id = ${params.attemptId}::uuid
        and upper(coalesce(status, '')) not in (
          'TERMINATED', 'ABANDONED', 'EXPIRED', 'FAILED', 'TIME_EXPIRED'
        )
      returning interview_id::text
    `;

    const interviewId = rows[0]?.interview_id;
    if (!interviewId) return;

    // This is the "we could not finalize this interview" path. It must not
    // report COMPLETED: that is the field recruiters see, and stamping success
    // here hid an unrepaired transcript behind a status that reads as a
    // finished candidate result.
    await tx.$executeRaw`
      update public.interviews
      set status = 'NEEDS_REVIEW',
          final_status = 'TRANSCRIPT_REVIEW_REQUIRED'
      where interview_id = ${interviewId}::uuid
        and upper(coalesce(final_status, '')) <> 'FINALIZED'
    `;
  });
}
