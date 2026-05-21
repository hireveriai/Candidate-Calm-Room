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

function readRootCertificate(rawConnectionString) {
  const url = new URL(rawConnectionString);
  const candidates = [
    url.searchParams.get("sslrootcert"),
    process.env.PGSSLROOTCERT,
    path.join(repoRoot, "certs", "supabase-pooler-chain.pem"),
    path.join(repoRoot, "certs", "aws-rds-global-bundle.pem"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(repoRoot, candidate);
    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, "utf8");
    }
  }

  return null;
}

function config() {
  const raw = String(process.env.DATABASE_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("Missing DATABASE_URL");

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

  const sslMode = (url.searchParams.get("sslmode") || "").toLowerCase();
  const ca = readRootCertificate(raw);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslcert");
  url.searchParams.delete("sslkey");
  url.searchParams.delete("sslrootcert");

  const ssl =
    sslMode === "disable"
      ? false
      : ca
        ? { ca, rejectUnauthorized: true }
        : raw.includes("sslmode=")
          ? true
          : undefined;

  return {
    connectionString: url.toString(),
    ...(ssl === undefined ? {} : { ssl }),
    connectionTimeoutMillis: 10000,
  };
}

async function hasTable(client, tableName) {
  const result = await client.query("select to_regclass($1) as table_name", [
    `public.${tableName}`,
  ]);
  return Boolean(result.rows[0]?.table_name);
}

async function tableColumns(client, tableName) {
  if (!(await hasTable(client, tableName))) return [];
  const result = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position
    `,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

async function scalar(client, sql, params = []) {
  try {
    const result = await client.query(sql, params);
    return result.rows[0] || {};
  } catch (error) {
    return { error: error.message };
  }
}

async function listIndexes(client, tableName) {
  if (!(await hasTable(client, tableName))) return [];
  const result = await client.query(
    `
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = $1
      order by indexname
    `,
    [tableName]
  );
  return result.rows;
}

async function main() {
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(repoRoot, ".env.local"));

  const client = new Client(config());
  await client.connect();

  const tables = [
    "interview_answers",
    "session_questions",
    "interview_attempts",
    "interview_invites",
    "interview_signals",
    "interview_recordings",
    "interview_recovery_events",
    "forensic_transcripts",
    "interviews",
    "candidates",
    "job_positions",
  ];

  const schema = {};
  for (const table of tables) {
    schema[table] = {
      exists: await hasTable(client, table),
      columns: await tableColumns(client, table),
      indexes: await listIndexes(client, table),
    };
  }

  const duplicateAnswers = await scalar(
    client,
    `
      select count(*)::int as duplicate_groups,
             coalesce(sum(answer_count - 1), 0)::int as duplicate_rows
      from (
        select session_question_id, count(*)::int as answer_count
        from public.interview_answers
        where session_question_id is not null
        group by session_question_id
        having count(*) > 1
      ) duplicates
    `
  );

  const duplicateAttempts = await scalar(
    client,
    `
      select count(*)::int as duplicate_groups,
             coalesce(sum(attempt_count - 1), 0)::int as duplicate_rows
      from (
        select interview_id, attempt_number, count(*)::int as attempt_count
        from public.interview_attempts
        group by interview_id, attempt_number
        having count(*) > 1
      ) duplicates
    `
  );

  const duplicateSessionQuestionOrders = await scalar(
    client,
    `
      select count(*)::int as duplicate_groups,
             coalesce(sum(question_count - 1), 0)::int as duplicate_rows
      from (
        select attempt_id, question_order, count(*)::int as question_count
        from public.session_questions
        where question_order is not null
        group by attempt_id, question_order
        having count(*) > 1
      ) duplicates
    `
  );

  const tableCounts = {};
  for (const table of tables) {
    if (schema[table].exists) {
      tableCounts[table] = await scalar(
        client,
        `select count(*)::int as rows from public.${table}`
      );
    }
  }

  const activity = await scalar(
    client,
    `
      select count(*)::int as total_connections,
             count(*) filter (where state = 'active')::int as active_connections,
             count(*) filter (where wait_event_type is not null)::int as waiting_connections
      from pg_stat_activity
      where datname = current_database()
    `
  );

  const missingRequiredForScript = [];
  for (const table of [
    "interview_answers",
    "session_questions",
    "interview_attempts",
    "interview_invites",
    "interviews",
    "candidates",
    "job_positions",
  ]) {
    if (!schema[table].exists) missingRequiredForScript.push(table);
  }

  const report = {
    inspectedAt: new Date().toISOString(),
    database: await scalar(client, "select current_database() as name, current_user as user_name"),
    activity,
    tableCounts,
    integrity: {
      duplicateAnswers,
      duplicateAttempts,
      duplicateSessionQuestionOrders,
    },
    missingRequiredForScript,
    optionalTablesMissing: tables.filter((table) => !schema[table].exists),
    schema,
  };

  const outputPath = path.join(repoRoot, "concurrency-db-inspection.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    outputPath,
    activity,
    tableCounts,
    integrity: report.integrity,
    missingRequiredForScript,
    optionalTablesMissing: report.optionalTablesMissing,
  }, null, 2));

  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
