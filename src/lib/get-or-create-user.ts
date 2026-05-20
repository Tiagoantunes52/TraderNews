import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

export async function getOrCreateUser() {
  const { userId } = await auth();
  if (!userId) return null;

  return db.user.upsert({
    where: { clerkId: userId },
    update: {},
    create: { clerkId: userId },
  });
}
