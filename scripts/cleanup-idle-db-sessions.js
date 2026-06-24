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

  const minIdleSeconds = Number(process.argv[2] ?? 120);
  const client = new Client(config());
  await client.connect();

  const result = await client.query(
    `
      with candidates as (
        select
          pid,
          usename,
          state,
          now() - state_change as idle_for,
          left(query, 180) as query
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state = 'idle'
          and usename = 'postgres'
          and now() - state_change > make_interval(secs => $1::double precision)
      )
      select
        pid,
        usename,
        state,
        idle_for::text,
        query,
        pg_terminate_backend(pid) as terminated
      from candidates
      order by idle_for desc
    `,
    [Number.isFinite(minIdleSeconds) && minIdleSeconds > 0 ? minIdleSeconds : 120]
  );

  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
