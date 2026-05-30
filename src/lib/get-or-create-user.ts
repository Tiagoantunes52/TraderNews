import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

export type AppUser = Awaited<ReturnType<typeof loadByClerkId>>;

async function loadByClerkId(clerkId: string) {
  return db.user.findUnique({ where: { clerkId } });
}

async function fetchClerkEmail(clerkId: string): Promise<string | null> {
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(clerkId);
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  const email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  return email?.toLowerCase().trim() ?? null;
}

/**
 * Resolve the signed-in user, applying invite-only access for new signups.
 *
 * Returns null when:
 *  - no Clerk session
 *  - new Clerk user has no matching pending invitation
 *
 * Existing TraderNews users are grandfathered in (no invitation check).
 */
export async function getOrCreateUser() {
  const { userId } = await auth();
  if (!userId) return null;

  // Existing user — fast path
  let user = await loadByClerkId(userId);
  if (user) {
    // Lazy backfill of email so admin lookups + invitations work for legacy users
    if (!user.email) {
      const email = await fetchClerkEmail(userId);
      if (email) {
        user = await db.user.update({
          where: { id: user.id },
          data: { email },
        });
      }
    }
    return user;
  }

  // New Clerk user — require a matching invitation
  const email = await fetchClerkEmail(userId);
  if (!email) return null;

  const invitation = await db.invitation.findUnique({ where: { email } });
  if (!invitation || invitation.acceptedAt) {
    // No pending invitation → block
    return null;
  }

  // Create user + mark invitation accepted in a single transaction
  const [createdUser] = await db.$transaction([
    db.user.create({
      data: { clerkId: userId, email, role: "USER" },
    }),
    db.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    }),
  ]);

  // Link the invitation to the newly created user (separate update — needs the new id)
  await db.invitation.update({
    where: { id: invitation.id },
    data: { acceptedByUserId: createdUser.id },
  });

  return createdUser;
}
