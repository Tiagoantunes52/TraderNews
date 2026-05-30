import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export async function DELETE(_req: Request, { params }: RouteContext<"/api/admin/invitations/[id]">) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const { id } = await params;

  const invitation = await db.invitation.findUnique({ where: { id } });
  if (!invitation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (invitation.acceptedAt) {
    return NextResponse.json(
      { error: "Cannot revoke an accepted invitation — remove the user instead" },
      { status: 409 }
    );
  }

  // Best-effort revoke at Clerk. If Clerk says it's already gone/revoked, proceed.
  if (invitation.clerkInvitationId) {
    try {
      const clerk = await clerkClient();
      await clerk.invitations.revokeInvitation(invitation.clerkInvitationId);
    } catch (err) {
      // Surface only unexpected failures; "already revoked" should not block local cleanup.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already|revoked|not.*found/i.test(message)) {
        return NextResponse.json(
          { error: `Clerk revoke failed: ${message}` },
          { status: 502 }
        );
      }
    }
  }

  await db.invitation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
