/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config({ path: ".env.local" });

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const { Client } = require("pg");
const { EgressClient, EgressStatus } = require("livekit-server-sdk");

const terminalStatuses = new Set([
  EgressStatus.EGRESS_COMPLETE,
  EgressStatus.EGRESS_FAILED,
  EgressStatus.EGRESS_ABORTED,
  EgressStatus.EGRESS_LIMIT_REACHED,
]);

function normalizeLiveKitHost(url) {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
  return url;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function getEgressClient() {
  return new EgressClient(
    normalizeLiveKitHost(requireEnv("LIVEKIT_URL")),
    requireEnv("LIVEKIT_API_KEY"),
    requireEnv("LIVEKIT_API_SECRET"),
  );
}

function liveKitTimestampToDate(value) {
  if (!value || value <= BigInt(0)) return null;
  const milliseconds = Number(value / BigInt(1_000_000));
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

async function stopRecording(egressId) {
  const client = getEgressClient();
  const stopped = await client.stopEgress(egressId);
  if (terminalStatuses.has(stopped.status)) return stopped;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const [current] = await client.listEgress({ egressId });
    if (current && terminalStatuses.has(current.status)) return current;
  }

  return stopped;
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findStorageObject(client, filePath) {
  if (!filePath) return null;
  const bucket =
    process.env.RECORDING_S3_BUCKET?.trim() ||
    process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
    "recordings";
  const result = await client.query(
    `
      select name, (metadata->>'size')::bigint as size, created_at, updated_at
      from storage.objects
      where bucket_id = $1
        and name = $2
      limit 1
    `,
    [bucket, filePath],
  );

  return result.rows[0] ?? null;
}

async function buildAttemptTranscript(client, attemptId) {
  const result = await client.query(
    `
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
      where sq.attempt_id = $1::uuid
      order by sq.asked_at asc nulls last, sq.question_order asc nulls last
    `,
    [attemptId],
  );

  const lines = result.rows.flatMap((row, index) => {
    const questionNumber = row.question_order ?? index + 1;
    const question = String(row.question_text ?? "").replace(/\s+/g, " ").trim();
    const answer = row.code_text
      ? `[Coding submission in ${row.language || "code"}]\n${String(row.code_text).trim()}`
      : String(row.answer_text ?? "").replace(/\s+/g, " ").trim();
    return [
      question ? `VERIS Q${questionNumber}: ${question}` : null,
      answer ? `Candidate A${questionNumber}: ${answer}` : null,
    ].filter(Boolean);
  });

  return lines.join("\n\n") || null;
}

async function finalizeRecording(client, row) {
  const storageObjectBeforeStop = await findStorageObject(client, row.file_path);
  let egress = null;
  let stopError = null;

  try {
    egress = await withTimeout(stopRecording(row.egress_id), 45_000, "LiveKit stopEgress");
  } catch (error) {
    stopError = error;
  }

  const storageObjectAfterStop =
    (await findStorageObject(client, row.file_path)) ?? storageObjectBeforeStop;
  const hasStoredObject = Number(storageObjectAfterStop?.size ?? 0) > 0;
  const completed =
    egress?.status === EgressStatus.EGRESS_COMPLETE || (!egress && hasStoredObject);
  const failureReason = completed
    ? null
    : stopError instanceof Error
      ? stopError.message
      : egress?.error || `LiveKit egress ended with status ${egress?.status ?? "unknown"}`;
  const fileResult = egress?.fileResults?.[0];
  const mediaStartedAt =
    liveKitTimestampToDate(fileResult?.startedAt ?? BigInt(0)) ??
    liveKitTimestampToDate(egress?.startedAt ?? BigInt(0));
  const mediaEndedAt =
    liveKitTimestampToDate(fileResult?.endedAt ?? BigInt(0)) ??
    liveKitTimestampToDate(egress?.endedAt ?? BigInt(0)) ??
    storageObjectAfterStop?.updated_at ??
    new Date();
  const transcript = completed ? await buildAttemptTranscript(client, row.attempt_id) : null;

  await client.query("begin");
  try {
    await client.query(
      `
        update public.interview_recordings
        set status = $2::text,
            failure_reason = $3::text,
            transcript = coalesce($4::text, transcript),
            started_at = coalesce($5::timestamptz, started_at),
            ended_at = $6::timestamptz
        where recording_id = $1::uuid
      `,
      [
        row.recording_id,
        completed ? "completed" : "failed",
        failureReason,
        transcript,
        mediaStartedAt,
        mediaEndedAt,
      ],
    );
    await client.query(
      `
        update public.interview_attempts
        set recording_status = $2::text
        where attempt_id = $1::uuid
      `,
      [row.attempt_id, completed ? "FINALIZED" : "FAILED"],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }

  return {
    recordingId: row.recording_id,
    attemptId: row.attempt_id,
    egressId: row.egress_id,
    status: completed ? "completed" : "failed",
    error: failureReason,
    recoveredFromStorageObject: Boolean(!egress && hasStoredObject),
  };
}

async function main() {
  const attemptArg = process.argv.includes("--attempt")
    ? process.argv[process.argv.indexOf("--attempt") + 1]
    : null;
  const limitArg = process.argv.includes("--limit")
    ? Number(process.argv[process.argv.indexOf("--limit") + 1])
    : 20;
  const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(limitArg, 100)) : 20;
  const client = new Client({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  });

  await client.connect();
  const result = await client.query(
    `
      select recording_id::text, attempt_id::text, egress_id, file_path
      from public.interview_recordings
      where status = 'recording'
        and egress_id is not null
        and ($1::uuid is null or attempt_id = $1::uuid)
      order by coalesce(started_at, created_at) asc
      limit $2
    `,
    [attemptArg || null, limit],
  );

  const finalized = [];
  for (const row of result.rows) {
    finalized.push(await finalizeRecording(client, row));
  }

  await client.end();
  console.log(JSON.stringify({ checked: result.rows.length, finalized }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
