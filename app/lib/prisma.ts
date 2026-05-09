process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

type PrismaClientLike = Record<string, any>;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientLike | undefined;
  prismaPool: Pool | undefined;
};

function createPrismaClient(): PrismaClientLike {
  const { PrismaClient } = require("@prisma/client");
  const maxConnections = Number(process.env.PG_POOL_MAX ?? 5);
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 10000);
  const connectionTimeoutMillis = Number(
    process.env.PG_CONNECTION_TIMEOUT_MS ?? 5000
  );
  const pool =
    globalForPrisma.prismaPool ||
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 5,
      idleTimeoutMillis:
        Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis > 0
          ? idleTimeoutMillis
          : 10000,
      connectionTimeoutMillis:
        Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0
          ? connectionTimeoutMillis
          : 5000,
      allowExitOnIdle: true,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prismaPool = pool;
  }

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
