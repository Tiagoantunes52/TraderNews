import { PrismaClient, type PrismaClient as PC } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "@/lib/logger";

const globalForPrisma = globalThis as unknown as { prisma: PC<never, undefined> };

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const client = new PrismaClient({
    adapter,
    log: [
      { level: "warn", emit: "event" },
      { level: "error", emit: "event" },
    ],
  });
  // Prisma emits some failures (pool timeouts, dropped connections to the
  // Supabase pooler) as events rather than thrown exceptions — forward them so
  // they're visible beyond Hobby's 1-hour log window.
  client.$on("warn", (e) => logger.warn("prisma_warn", { message: e.message, target: e.target }));
  client.$on("error", (e) => logger.error("prisma_error", { message: e.message, target: e.target }));
  return client as unknown as PC<never, undefined>;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
