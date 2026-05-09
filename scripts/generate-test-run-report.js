const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

const repoRoot = path.resolve(__dirname, "..");
const seedPath = path.join(repoRoot, "codex-e2e-seed.json");
const validationPath = path.join(repoRoot, "production-validation-report.json");
const outputPath = path.join(repoRoot, "TEST_RUN_REPORT.md");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env.local"));

function formatList(items) {
  if (!items.length) {
    return "- none";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

async function main() {
  if (!fs.existsSync(seedPath)) {
    throw new Error("codex-e2e-seed.json not found");
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const validation = fs.existsSync(validationPath)
    ? JSON.parse(fs.readFileSync(validationPath, "utf8"))
    : null;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  const interviewRows = await client.query(
    `
      select
        i.interview_id,
        i.candidate_id,
        c.full_name,
        i.status,
        i.final_status,
        ia.attempt_id,
        ia.status as attempt_status,
        ia.time_elapsed_seconds,
        ia.questions_answered,
        ia.completion_percentage,
        ia.reliability_score,
        ia.termination_metadata,
        s.hire_recommendation,
        s.overall_score,
        s.risk_level,
        r.result_status,
        (
          select count(*) from public.session_questions sq where sq.attempt_id = ia.attempt_id
        )::int as total_questions,
        (
          select count(*) from public.session_questions sq where sq.attempt_id = ia.attempt_id and sq.question_kind = 'follow_up'
        )::int as follow_up_questions,
        (
          select count(*) from public.interview_recovery_events ire where ire.attempt_id = ia.attempt_id
        )::int as reconnect_events,
        (
          select count(*) from public.forensic_transcripts ft where ft.attempt_id = ia.attempt_id
        )::int as transcript_segments,
        (
          select count(*) from public.interview_recordings ir where ir.attempt_id = ia.attempt_id and ir.ended_at is not null
        )::int as finalized_recordings
      from public.interviews i
      join public.candidates c
        on c.candidate_id = i.candidate_id
      left join public.interview_attempts ia
        on ia.interview_id = i.interview_id
      left join public.interview_summaries s
        on s.attempt_id = ia.attempt_id
      left join public.interview_results r
        on r.interview_id = i.interview_id
      where i.organization_id = $1::uuid
      order by c.full_name asc, ia.started_at desc nulls last
    `,
    [seed.organizationId]
  );

  const prismaErrors = [];
  const runtimeWarnings = validation?.warnings?.map((warning) => warning.code) ?? [];

  const sections = interviewRows.rows.map((row) => {
    const metadata = row.termination_metadata || {};
    return [
      `### Candidate ${row.full_name}`,
      `- candidate_id: \`${row.candidate_id}\``,
      `- interview_id: \`${row.interview_id}\``,
      `- attempt_id: \`${row.attempt_id ?? "n/a"}\``,
      `- interview_status: \`${row.status ?? "n/a"}\``,
      `- final_status: \`${row.final_status ?? "n/a"}\``,
      `- attempt_status: \`${row.attempt_status ?? "n/a"}\``,
      `- recommendation: \`${row.hire_recommendation ?? "n/a"}\``,
      `- score: \`${row.overall_score ?? metadata.final_score ?? "n/a"}\``,
      `- risk_level: \`${row.risk_level ?? metadata.risk_level ?? "n/a"}\``,
      `- result_status: \`${row.result_status ?? "n/a"}\``,
      `- time_elapsed_seconds: \`${row.time_elapsed_seconds ?? "n/a"}\``,
      `- questions: \`${row.total_questions ?? 0}\``,
      `- follow_ups: \`${row.follow_up_questions ?? 0}\``,
      `- transcript_segments: \`${row.transcript_segments ?? 0}\``,
      `- reconnect_events: \`${row.reconnect_events ?? 0}\``,
      `- recordings_finalized: \`${row.finalized_recordings ?? 0}\``,
      `- completion_percentage: \`${row.completion_percentage ?? "n/a"}\``,
      `- reliability_score: \`${row.reliability_score ?? "n/a"}\``,
    ].join("\n");
  });

  const report = `# TEST_RUN_REPORT

## Run Summary
- generated_at: \`${new Date().toISOString()}\`
- organization_id: \`${seed.organizationId}\`
- organization_name: \`${seed.organizationName}\`
- recruiter_id: \`${seed.recruiterId}\`
- job_id: \`${seed.jobId}\`
- production_base_url: \`${validation?.baseUrl ?? seed.baseUrl}\`

## Validation Status
- build_ok: \`${validation?.build?.ok ?? false}\`
- runtime_ok: \`${validation?.runtime?.ok ?? false}\`
- database_ok: \`${validation?.database?.ok ?? false}\`
- websocket_ok: \`${validation?.websocket?.ok ?? false}\`
- calm_room_ok: \`${validation?.calmRoom?.ok ?? false}\`

## Interviews
${sections.join("\n\n")}

## Transcript Integrity
${formatList(
  interviewRows.rows.map((row) =>
    `${row.full_name}: transcript_segments=${row.transcript_segments ?? 0}, completion=${row.completion_percentage ?? "n/a"}`
  )
)}

## Reconnect Events
${formatList(
  interviewRows.rows.map((row) => `${row.full_name}: reconnect_events=${row.reconnect_events ?? 0}`)
)}

## Prisma Errors
${formatList(prismaErrors)}

## Completion Timing
${formatList(
  interviewRows.rows.map((row) => `${row.full_name}: elapsed_seconds=${row.time_elapsed_seconds ?? "n/a"}`)
)}

## Runtime Warnings
${formatList(runtimeWarnings)}
`;

  fs.writeFileSync(outputPath, report);
  await client.end();
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
