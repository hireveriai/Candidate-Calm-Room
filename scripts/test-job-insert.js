const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const repoRoot = path.resolve(__dirname, "..");

for (const file of [".env", ".env.local"]) {
  const fp = path.join(repoRoot, file);
  if (!fs.existsSync(fp)) continue;
  for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const raw = process.env.DATABASE_URL.trim().replace(/^["']|["']$/g, "");
const url = new URL(raw);
if (
  process.env.HIREVERI_USE_DIRECT_DB === "1" &&
  url.hostname.includes("pooler.supabase.com") &&
  url.username.startsWith("postgres.")
) {
  const projectRef = url.username.slice("postgres.".length);
  url.username = "postgres";
  url.hostname = `db.${projectRef}.supabase.co`;
  url.port = "5432";
}
url.searchParams.delete("sslmode");
const ca = fs.readFileSync(path.join(repoRoot, "certs", "supabase-pooler-chain.pem"), "utf8");

async function main() {
  const client = new Client({
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  const org = (await client.query(`
    insert into public.organizations (organization_name, timezone, timezone_label)
    values ('Codex Job Insert Smoke ' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 'Asia/Kolkata', 'India Standard Time')
    returning organization_id
  `)).rows[0];
  console.log("org", org);
  const recruiter = (await client.query(`
    insert into public.users (organization_id, full_name, email, role, is_active)
    values ($1, 'Smoke Recruiter', 'smoke.' || replace($1::text, '-', '') || '@example.com', 'RECRUITER', true)
    returning user_id
  `, [org.organization_id])).rows[0];
  const candidate = (await client.query(`
    insert into public.candidates (organization_id, full_name, email)
    values ($1, 'Smoke Candidate', 'candidate.' || replace($1::text, '-', '') || '@example.com')
    returning candidate_id
  `, [org.organization_id])).rows[0];
  const started = Date.now();
  await client.query("begin");
  try {
    const result = await client.query(
      `
        insert into public.job_positions (
          organization_id,
          job_title,
          job_description,
          experience_level,
          core_skills,
          difficulty_profile
        )
        values ($1, 'Codex Job Insert Smoke', 'Smoke', 'Senior', $2::text[], 'SENIOR')
        returning job_id
      `,
      [org.organization_id, ["SQL"]]
    );
    console.log("inserted", result.rows[0], Date.now() - started);
    const interview = await client.query(`
      insert into public.interviews (
        organization_id,
        job_id,
        candidate_id,
        interview_type,
        created_by,
        duration_minutes,
        question_count,
        required_follow_up_questions,
        ai_strictness,
        resume_ai_enabled,
        max_attempts,
        recovery_allowed,
        proctoring_enabled,
        status,
        final_status
      )
      values ($1,$2,$3,'TECHNICAL',$4,30,8,7,'HIGH',true,1,true,true,'SCHEDULED','PENDING')
      returning interview_id
    `, [org.organization_id, result.rows[0].job_id, candidate.candidate_id, recruiter.user_id]);
    console.log("interview", interview.rows[0], Date.now() - started);
  } finally {
    await client.query("rollback");
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
