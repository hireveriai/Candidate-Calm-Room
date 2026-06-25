import { EgressStatus } from "livekit-server-sdk";

import { prisma } from "@/app/lib/prisma";
import { stopRecording } from "@/app/lib/livekit/egress";

type AttemptTranscriptRow = {
  question_order: number | null;
  question_text: string | null;
  answer_text: string | null;
};

function liveKitTimestampToDate(value: bigint) {
  if (value <= BigInt(0)) {
    return null;
  }

  const milliseconds = Number(value / BigInt(1_000_000));
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

async function buildAttemptTranscript(attemptId: string) {
  const rows = await prisma.$queryRaw<
    AttemptTranscriptRow[]
  >`
    select
      sq.question_order,
      sq.content as question_text,
      ia.answer_text
    from public.session_questions sq
    left join public.interview_answers ia
      on ia.session_question_id = sq.session_question_id
    where sq.attempt_id = ${attemptId}::uuid
    order by sq.asked_at asc nulls last, sq.question_order asc nulls last
  `;

  const lines = (rows as AttemptTranscriptRow[]).flatMap((row: AttemptTranscriptRow, index: number) => {
    const questionNumber = row.question_order ?? index + 1;
    const question = row.question_text?.replace(/\s+/g, " ").trim();
    const answer = row.answer_text?.replace(/\s+/g, " ").trim();

    return [
      question ? `VERIS Q${questionNumber}: ${question}` : null,
      answer ? `Candidate A${questionNumber}: ${answer}` : null,
    ].filter((value): value is string => Boolean(value));
  });

  return lines.join("\n\n") || null;
}

export async function finalizeRecordingByEgressId(egressId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ status: string | null; attempt_id: string | null }>
  >`
    select status, attempt_id::text
    from public.interview_recordings
    where egress_id = ${egressId}
    limit 1
  `;

  const recording = rows[0];
  if (!recording?.attempt_id) {
    return { found: false, completed: false, status: "missing", error: "Recording not found" };
  }

  if (recording.status === "completed" || recording.status === "failed") {
    return {
      found: true,
      completed: recording.status === "completed",
      status: recording.status,
      error: null,
    };
  }

  try {
    const egress = await stopRecording(egressId);
    const completed = egress.status === EgressStatus.EGRESS_COMPLETE;
    const failureReason = completed
      ? null
      : egress.error || `LiveKit egress ended with status ${egress.status}`;
    const fileResult = egress.fileResults[0];
    const mediaStartedAt =
      liveKitTimestampToDate(fileResult?.startedAt ?? BigInt(0)) ??
      liveKitTimestampToDate(egress.startedAt);
    const mediaEndedAt =
      liveKitTimestampToDate(fileResult?.endedAt ?? BigInt(0)) ??
      liveKitTimestampToDate(egress.endedAt) ??
      new Date();
    const transcript = completed
      ? await buildAttemptTranscript(recording.attempt_id)
      : null;

    await prisma.$transaction([
      prisma.$executeRaw`
        update public.interview_recordings
        set status = ${completed ? "completed" : "failed"},
            failure_reason = ${failureReason},
            transcript = coalesce(${transcript}, transcript),
            started_at = coalesce(${mediaStartedAt}, started_at),
            ended_at = ${mediaEndedAt}
        where egress_id = ${egressId}
      `,
      prisma.$executeRaw`
        update public.interview_attempts
        set recording_status = ${completed ? "FINALIZED" : "FAILED"}
        where attempt_id = ${recording.attempt_id}::uuid
      `,
    ]);

    return {
      found: true,
      completed,
      status: completed ? "completed" : "failed",
      error: failureReason,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stop recording";

    await prisma.$transaction([
      prisma.$executeRaw`
        update public.interview_recordings
        set status = 'failed',
            failure_reason = coalesce(failure_reason, ${message}),
            ended_at = coalesce(ended_at, timezone('utc', now()))
        where egress_id = ${egressId}
      `,
      prisma.$executeRaw`
        update public.interview_attempts
        set recording_status = 'FAILED'
        where attempt_id = ${recording.attempt_id}::uuid
      `,
    ]).catch((updateError: unknown) => {
      console.error("Unable to persist recording finalization failure", updateError);
    });

    throw error;
  }
}

export async function finalizeActiveRecordings(attemptId: string) {
  const rows = await prisma.$queryRaw<Array<{ egress_id: string }>>`
    select egress_id
    from public.interview_recordings
    where attempt_id = ${attemptId}::uuid
      and status = 'recording'
      and egress_id is not null
    order by coalesce(started_at, created_at) desc
  `;

  const results = [];
  for (const row of rows) {
    try {
      results.push(await finalizeRecordingByEgressId(row.egress_id));
    } catch (error) {
      console.error("Unable to finalize active interview recording", {
        attemptId,
        egressId: row.egress_id,
        error,
      });
    }
  }

  return results;
}
