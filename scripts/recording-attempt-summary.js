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
  const raw = String(process.env.DATABASE_URL || "")
    .trim()
    .replace(/^["']|["']$/g, "");
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

  const limit = Math.min(Math.max(Number(process.argv[2] || 12), 1), 100);
  const client = new Client(databaseConfig());
  await client.connect();

  const result = await client.query(
    `
      with recent_attempts as (
        select
          ia.attempt_id,
          ia.interview_id,
          ia.status,
          ia.recording_status,
          ia.started_at,
          ia.ended_at
        from public.interview_attempts ia
        order by coalesce(ia.started_at, ia.ended_at) desc nulls last
        limit $1
      )
      select
        ra.attempt_id::text,
        ra.interview_id::text,
        ra.status as attempt_status,
        ra.recording_status,
        ra.started_at,
        ra.ended_at,
        count(ir.*)::int as recording_rows,
        count(*) filter (where ir.status = 'completed')::int as completed_rows,
        count(*) filter (where ir.status = 'recording')::int as active_rows,
        count(*) filter (where ir.status = 'failed')::int as failed_rows,
        count(*) filter (where ir.egress_id is not null)::int as livekit_rows,
        count(*) filter (where ir.egress_id is null and ir.file_path is not null)::int as browser_rows,
        max(ir.created_at) as latest_recording_created,
        (
          array_agg(ir.file_path order by ir.created_at desc)
            filter (where ir.status = 'completed' and ir.file_path is not null)
        )[1] as latest_completed_path
      from recent_attempts ra
      left join public.interview_recordings ir
        on ir.attempt_id = ra.attempt_id
      group by
        ra.attempt_id,
        ra.interview_id,
        ra.status,
        ra.recording_status,
        ra.started_at,
        ra.ended_at
      order by coalesce(ra.started_at, ra.ended_at) desc nulls last
    `,
    [limit],
  );

  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
