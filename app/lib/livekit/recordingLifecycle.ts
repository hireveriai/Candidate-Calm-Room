import { EgressStatus } from "livekit-server-sdk";

import { prisma } from "@/app/lib/prisma";
import { stopRecording } from "@/app/lib/livekit/egress";

type AttemptTranscriptRow = {
  question_order: number | null;
  question_text: string | null;
  answer_text: string | null;
  code_text: string | null;
  language: string | null;
};

type RecoverableRecordingRow = {
  recording_id: string;
  file_path: string | null;
  video_url: string | null;
  audio_url: string | null;
};

function liveKitTimestampToDate(value: bigint) {
  if (value <= BigInt(0)) {
    return null;
  }

  const milliseconds = Number(value / BigInt(1_000_000));
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

export async function buildAttemptTranscript(attemptId: string) {
  const rows = await prisma.$queryRaw<
    AttemptTranscriptRow[]
  >`
    select
      sq.question_order,
      sq.content as question_text,
      ia.answer_text,
      cs.code_text,
      cs.language
    from public.session_questions sq
    left join public.interview_answers ia
      on ia.session_question_id = sq.session_question_id
    left join public.interview_code_submissions cs
      on cs.answer_id = ia.answer_id
    where sq.attempt_id = ${attemptId}::uuid
    order by sq.asked_at asc nulls last, sq.question_order asc nulls last
  `;

  const lines = (rows as AttemptTranscriptRow[]).flatMap((row: AttemptTranscriptRow, index: number) => {
    const questionNumber = row.question_order ?? index + 1;
    const question = row.question_text?.replace(/\s+/g, " ").trim();
    const code = row.code_text?.trim();
    const answer = code
      ? `[Coding submission in ${row.language || "code"}]\n${code}`
      : row.answer_text?.replace(/\s+/g, " ").trim();

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

function getRecordingBucket() {
  return (
    process.env.RECORDING_S3_BUCKET?.trim() ||
    process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
    "recordings"
  );
}

function normalizeStoragePath(row: RecoverableRecordingRow) {
  const raw = row.file_path || row.video_url || row.audio_url || "";
  const match = raw.match(/\/object\/(?:public|sign)\/[^/]+\/(.+)$/);

  return decodeURIComponent(match?.[1] ?? raw).replace(/^\/+/, "");
}

async function recoverCompletedStorageRecordings(attemptId: string) {
  const rows = await prisma.$queryRaw<RecoverableRecordingRow[]>`
    select
      recording_id::text,
      file_path,
      video_url,
      audio_url
    from public.interview_recordings
    where attempt_id = ${attemptId}::uuid
      and coalesce(status, '') <> 'completed'
      and coalesce(file_path, video_url, audio_url, '') <> ''
  `;

  const bucket = getRecordingBucket();
  const transcript = rows.length > 0 ? await buildAttemptTranscript(attemptId) : null;
  const recovered = [];

  for (const row of rows) {
    const filePath = normalizeStoragePath(row);
    if (!filePath) {
      continue;
    }

    const objects = await prisma.$queryRaw<Array<{ id: string }>>`
      select id::text
      from storage.objects
      where bucket_id = ${bucket}
        and name = ${filePath}
      limit 1
    `;

    if (!objects[0]) {
      continue;
    }

    await prisma.$transaction([
      prisma.$executeRaw`
        update public.interview_recordings
        set status = 'completed',
            failure_reason = null,
            transcript = coalesce(${transcript}, transcript),
            ended_at = coalesce(ended_at, timezone('utc', now()))
        where recording_id = ${row.recording_id}::uuid
      `,
      prisma.$executeRaw`
        update public.interview_attempts
        set recording_status = 'FINALIZED'
        where attempt_id = ${attemptId}::uuid
      `,
    ]);

    recovered.push({ recordingId: row.recording_id, filePath });
  }

  return recovered;
}

export async function finalizeActiveRecordings(attemptId: string) {
  const recoveredBeforeStop = await recoverCompletedStorageRecordings(attemptId);
  const rows = await prisma.$queryRaw<Array<{ egress_id: string }>>`
    select egress_id
    from public.interview_recordings
    where attempt_id = ${attemptId}::uuid
      and status = 'recording'
      and egress_id is not null
    order by coalesce(started_at, created_at) desc
  `;

  const results = [];
  results.push(...recoveredBeforeStop.map((row) => ({
    found: true,
    completed: true,
    status: "completed",
    error: null,
    recoveredFromStorageObject: true,
    ...row,
  })));

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

  const recoveredAfterStop = await recoverCompletedStorageRecordings(attemptId);
  results.push(...recoveredAfterStop.map((row) => ({
    found: true,
    completed: true,
    status: "completed",
    error: null,
    recoveredFromStorageObject: true,
    ...row,
  })));

  return results;
}
