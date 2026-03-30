process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const { PrismaClient } = require("@prisma/client");

const globalForPrisma = global as unknown as {
  prisma: InstanceType<typeof PrismaClient> | undefined;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
