import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildPgConnectionConfig } from "@/app/lib/pgConnection";

type PrismaClientLike = Record<string, any>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientLike | undefined;
  prismaPool: Pool | undefined;
};

function createPrismaClient(): PrismaClientLike {
  const { PrismaClient } = require("@prisma/client");
  const requestedMaxConnections = Number(process.env.PG_POOL_MAX ?? 1);
  const maxConnectionCap = Number(process.env.PG_POOL_MAX_CAP ?? 1);
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 1000);
  const connectionTimeoutMillis = Number(
    process.env.PG_CONNECTION_TIMEOUT_MS ?? 8000
  );
  const maxLifetimeSeconds = Number(
    process.env.PG_MAX_LIFETIME_SECONDS ?? 30
  );
  const boundedMaxConnections =
    Number.isFinite(requestedMaxConnections) && requestedMaxConnections > 0
      ? requestedMaxConnections
      : 1;
  const boundedConnectionCap =
    Number.isFinite(maxConnectionCap) && maxConnectionCap > 0
      ? maxConnectionCap
      : 1;
  const pool =
    globalForPrisma.prismaPool ||
    new Pool({
      ...buildPgConnectionConfig(process.env.DATABASE_URL),
      max: Math.max(1, Math.min(boundedMaxConnections, boundedConnectionCap)),
      idleTimeoutMillis:
        Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis > 0
          ? idleTimeoutMillis
          : 1000,
      connectionTimeoutMillis:
        Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0
          ? connectionTimeoutMillis
          : 8000,
      maxLifetimeSeconds:
        Number.isFinite(maxLifetimeSeconds) && maxLifetimeSeconds > 0
          ? maxLifetimeSeconds
          : 30,
      allowExitOnIdle: true,
    });

  globalForPrisma.prismaPool = pool;

  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
  });
}

function getPrismaClient(): PrismaClientLike {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClientLike, {
  get(_, prop) {
    const client = getPrismaClient();
    const value = client[prop as keyof PrismaClientLike];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
