const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const repoRoot = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function databaseConfig() {
  const raw = String(process.env.DATABASE_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("DATABASE_URL is not configured");
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  const caPath = path.join(repoRoot, "certs", "supabase-pooler-chain.pem");
  return {
    connectionString: url.toString(),
    ssl: fs.existsSync(caPath)
      ? { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true }
      : true,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  };
}

async function main() {
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(repoRoot, ".env.local"));

  const limit = Math.min(Math.max(Number(process.argv[2] || 50), 1), 500);
  const bucket =
    process.env.RECORDING_S3_BUCKET?.trim() ||
    process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
    "recordings";
  const client = new Client(databaseConfig());
  await client.connect();

  const result = await client.query(
    `
      with recent_recordings as (
        select
          ir.recording_id::text,
          ir.attempt_id::text,
          ir.egress_id,
          ir.status,
          ir.file_path,
          ir.failure_reason,
          ir.started_at,
          ir.ended_at,
          ir.created_at
        from public.interview_recordings ir
        order by coalesce(ir.created_at, ir.started_at) desc nulls last
        limit $1
      )
      select
        rr.*,
        ia.status as attempt_status,
        ia.transcript_status,
        ia.recording_status,
        coalesce(ft.segment_count, 0)::int as transcript_segments,
        coalesce(ft.nonempty_count, 0)::int as nonempty_transcript_segments,
        coalesce(sig.signal_count, 0)::int as timeline_signals,
        so.name as storage_object_name,
        (so.metadata->>'size')::bigint as storage_size_bytes,
        so.created_at as storage_created_at,
        so.updated_at as storage_updated_at
      from recent_recordings rr
      left join public.interview_attempts ia on ia.attempt_id = rr.attempt_id::uuid
      left join lateral (
        select
          count(*) as segment_count,
          count(*) filter (where nullif(trim(transcript), '') is not null) as nonempty_count
        from public.forensic_transcripts
        where attempt_id = rr.attempt_id::uuid
      ) ft on true
      left join lateral (
        select count(*) as signal_count
        from public.interview_signals
        where attempt_id = rr.attempt_id::uuid
      ) sig on true
      left join storage.objects so
        on so.bucket_id = $2
       and so.name = rr.file_path
      order by coalesce(rr.created_at, rr.started_at) desc nulls last
    `,
    [limit, bucket],
  );

  const rows = result.rows.map((row) => ({
    ...row,
    storage_size_bytes:
      row.storage_size_bytes === null ? null : Number(row.storage_size_bytes),
  }));
  const finalized = rows.filter(
    (row) => row.status === "completed" || row.recording_status === "FINALIZED",
  );
  const active = rows.filter((row) => row.status === "recording");
  const failed = rows.filter(
    (row) => row.status === "failed" || row.recording_status === "FAILED",
  );
  const missingObjects = finalized.filter((row) => !row.storage_object_name);
  const emptyObjects = finalized.filter(
    (row) => row.storage_size_bytes !== null && row.storage_size_bytes <= 0,
  );
  const missingTranscripts = finalized.filter(
    (row) => row.nonempty_transcript_segments <= 0,
  );
  const missingTimelines = finalized.filter((row) => row.timeline_signals <= 0);

  console.log(
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        bucket,
        checked: rows.length,
        summary: {
          finalized: finalized.length,
          active: active.length,
          failed: failed.length,
          finalized_missing_storage_object: missingObjects.length,
          finalized_empty_storage_object: emptyObjects.length,
          finalized_missing_transcript: missingTranscripts.length,
          finalized_missing_timeline_signals: missingTimelines.length,
        },
        failures: {
          failed_recordings: failed,
          finalized_missing_storage_object: missingObjects,
          finalized_empty_storage_object: emptyObjects,
          finalized_missing_transcript: missingTranscripts,
          finalized_missing_timeline_signals: missingTimelines,
        },
        recordings: rows,
      },
      null,
      2,
    ),
  );

  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
