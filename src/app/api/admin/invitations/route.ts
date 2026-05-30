import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractClerkError(err: unknown): string {
  if (err && typeof err === "object" && "errors" in err) {
    const errors = (err as { errors?: Array<{ code?: string; message?: string; longMessage?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors
        .map((e) => e.longMessage ?? e.message ?? e.code ?? "Unknown error")
        .join("; ");
    }
  }
  if (err instanceof Error) return err.message;
  return "Failed to send invitation email";
}

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const invitations = await db.invitation.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      invitedBy: { select: { email: true } },
      acceptedBy: { select: { email: true } },
    },
  });

  return NextResponse.json(invitations);
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const { email: raw } = (await req.json().catch(() => ({}))) as { email?: string };
  const email = raw?.toLowerCase().trim();

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json(
      { error: "A user with that email already has access" },
      { status: 409 }
    );
  }

  const existingInvite = await db.invitation.findUnique({ where: { email } });
  if (existingInvite) {
    return NextResponse.json(
      { error: existingInvite.acceptedAt ? "Already accepted" : "Already invited" },
      { status: 409 }
    );
  }

  // Build the redirect URL Clerk lands the invitee on after they click the email.
  // Prefer an explicit APP_URL so invitees on other machines don't get sent to localhost;
  // VERCEL_URL is auto-set on Vercel deployments; request origin is the last resort.
  const appUrl =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    new URL(req.url).origin;
  const redirectUrl = `${appUrl.replace(/\/$/, "")}/sign-up`;

  let clerkInvitationId: string | null = null;
  try {
    const clerk = await clerkClient();
    const clerkInvitation = await clerk.invitations.createInvitation({
      emailAddress: email,
      redirectUrl,
      notify: true,
    });
    clerkInvitationId = clerkInvitation.id;
  } catch (err) {
    // Clerk errors carry rich detail on `errors[]`; surface it so the admin sees the real reason.
    const detail = extractClerkError(err);
    console.error("Clerk createInvitation failed", { email, redirectUrl, detail, err });
    return NextResponse.json(
      { error: `Clerk invitation failed: ${detail}` },
      { status: 502 }
    );
  }

  const invitation = await db.invitation.create({
    data: { email, invitedById: guard.user.id, clerkInvitationId },
  });

  return NextResponse.json(invitation, { status: 201 });
}
