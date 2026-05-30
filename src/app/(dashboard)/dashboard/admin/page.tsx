import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import { InvitationsManager } from "./invitations-manager";

export const metadata = { title: "Admin — TraderNews" };

export default async function AdminPage() {
  const user = await getOrCreateUser();
  if (!isAdmin(user)) notFound();

  const invitations = await db.invitation.findMany({
    orderBy: [{ acceptedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    include: {
      invitedBy: { select: { email: true } },
      acceptedBy: { select: { email: true } },
    },
  });

  const serialized = invitations.map((i) => ({
    id: i.id,
    email: i.email,
    invitedByEmail: i.invitedBy.email,
    acceptedByEmail: i.acceptedBy?.email ?? null,
    acceptedAt: i.acceptedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Invite people to TraderNews. Only invited emails can sign up.
        </p>
      </div>

      <InvitationsManager initialInvitations={serialized} />
    </div>
  );
}
