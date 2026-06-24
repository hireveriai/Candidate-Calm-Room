import type { PoolConfig } from "pg";
import fs from "fs";
import path from "path";

function readRootCertificate(rawConnectionString: string) {
  const url = new URL(rawConnectionString);
  const candidates = [
    url.searchParams.get("sslrootcert"),
    process.env.PGSSLROOTCERT,
    path.join(process.cwd(), "certs", "supabase-pooler-chain.pem"),
    path.join(process.cwd(), "certs", "aws-rds-global-bundle.pem"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(process.cwd(), candidate);

    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, "utf8");
    }
  }

  return null;
}

export function buildPgConnectionConfig(
  rawConnectionString: string | undefined
): Pick<PoolConfig, "connectionString" | "ssl"> {
  const raw = rawConnectionString?.trim().replace(/^["']|["']$/g, "");

  if (!raw) {
    return {
      connectionString: rawConnectionString,
    };
  }

  const url = new URL(raw);
  const forceTransactionPooler = process.env.DB_POOL_MODE !== "session";

  if (
    forceTransactionPooler &&
    url.hostname.endsWith(".pooler.supabase.com") &&
    (!url.port || url.port === "5432")
  ) {
    url.port = "6543";
  }

  if (
    forceTransactionPooler &&
    url.hostname.endsWith(".pooler.supabase.com") &&
    !url.searchParams.has("pgbouncer")
  ) {
    url.searchParams.set("pgbouncer", "true");
  }

  const sslMode = url.searchParams.get("sslmode")?.toLowerCase() ?? "";
  const ca = readRootCertificate(raw);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslcert");
  url.searchParams.delete("sslkey");
  url.searchParams.delete("sslrootcert");

  const ssl =
    sslMode === "disable"
      ? false
      : ca && ["allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)
        ? { ca, rejectUnauthorized: true }
        : sslMode === "allow" || sslMode === "prefer" || sslMode === "require"
          ? true
          : ca && raw.includes("sslmode=")
            ? { ca, rejectUnauthorized: true }
            : sslMode === "no-verify"
              ? { rejectUnauthorized: false }
              : raw.includes("sslmode=")
                ? true
                : undefined;

  return {
    connectionString: url.toString(),
    ...(ssl === undefined ? {} : { ssl }),
  };
}
