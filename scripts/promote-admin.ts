import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

async function main() {
  const email = process.argv[2]?.toLowerCase().trim();
  if (!email) {
    console.error("Usage: npx tsx scripts/promote-admin.ts <email>");
    process.exit(1);
  }

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    console.error("CLERK_SECRET_KEY is required");
    process.exit(1);
  }

  // Try to find an existing user by email first
  let user = await prisma.user.findUnique({ where: { email } });

  // Fallback: look up Clerk user by email and match by clerkId (covers users
  // who already exist in the DB but never had their email backfilled).
  if (!user) {
    const clerk = createClerkClient({ secretKey: clerkSecretKey });
    const matches = await clerk.users.getUserList({ emailAddress: [email] });
    if (matches.totalCount === 0) {
      console.error(`No Clerk user found with email ${email}`);
      process.exit(1);
    }
    const clerkId = matches.data[0].id;
    user = await prisma.user.findUnique({ where: { clerkId } });
    if (user) {
      // Backfill email so future lookups by email work
      user = await prisma.user.update({
        where: { id: user.id },
        data: { email },
      });
    }
  }

  if (!user) {
    console.error(`No TraderNews user exists yet for ${email}. Sign in once before promoting.`);
    process.exit(1);
  }

  const promoted = await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });

  console.log(`Promoted ${email} (user ${promoted.id}) to ADMIN.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
