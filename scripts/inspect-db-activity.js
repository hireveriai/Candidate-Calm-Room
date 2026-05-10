const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const repoRoot = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function config() {
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
  const ca = fs.readFileSync(
    path.join(repoRoot, "certs", "supabase-pooler-chain.pem"),
    "utf8"
  );
  return {
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  };
}

async function main() {
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(repoRoot, ".env.local"));
  const client = new Client(config());
  await client.connect();
  if (process.argv[2] === "columns" && process.argv[3]) {
    const result = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
        order by ordinal_position
      `,
      [process.argv[3]]
    );
    console.log(result.rows.map((row) => row.column_name).join("\n"));
    await client.end();
    return;
  }
  if (process.argv[2] === "triggers" && process.argv[3]) {
    const result = await client.query(
      `
        select trigger_name, action_timing, event_manipulation, action_statement
        from information_schema.triggers
        where event_object_schema = 'public'
          and event_object_table = $1
        order by trigger_name
      `,
      [process.argv[3]]
    );
    console.log(JSON.stringify(result.rows, null, 2));
    await client.end();
    return;
  }
  if (process.argv[2] === "function" && process.argv[3]) {
    const result = await client.query(
      `
        select pg_get_functiondef(p.oid) as definition
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = $1
        limit 1
      `,
      [process.argv[3]]
    );
    console.log(result.rows[0]?.definition || "");
    await client.end();
    return;
  }
  const result = await client.query(`
    select
      pid,
      usename,
      state,
      wait_event_type,
      wait_event,
      now() - query_start as query_age,
      left(query, 240) as query
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
    order by query_start nulls last
  `);
  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
