"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Mail, Send, Trash2, CheckCircle, Clock, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "@/lib/format-date";

type Invitation = {
  id: string;
  email: string;
  invitedByEmail: string | null;
  acceptedByEmail: string | null;
  acceptedAt: string | null;
  createdAt: string;
};

export function InvitationsManager({ initialInvitations }: { initialInvitations: Invitation[] }) {
  const router = useRouter();
  const [invitations, setInvitations] = useState(initialInvitations);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.toLowerCase().trim();
    if (!trimmed) return;

    startSubmit(async () => {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        const message = data.error ?? `Failed to invite (HTTP ${res.status})`;
        setError(message);
        toast.error("Couldn't send invitation", { description: message });
        return;
      }
      setEmail("");
      router.refresh();
      setInvitations((prev) => [
        {
          id: data.id,
          email: data.email,
          invitedByEmail: null,
          acceptedByEmail: null,
          acceptedAt: null,
          createdAt: data.createdAt,
        },
        ...prev,
      ]);
      toast.success(`Invitation sent to ${data.email}`);
    });
  };

  const revoke = async (id: string, inviteEmail: string) => {
    setRevokingId(id);
    const res = await fetch(`/api/admin/invitations/${id}`, { method: "DELETE" });
    if (res.ok) {
      setInvitations((prev) => prev.filter((i) => i.id !== id));
      router.refresh();
      toast.success(`Revoked invitation for ${inviteEmail}`);
    } else {
      const data = await res.json().catch(() => ({}));
      const message = data.error ?? "Failed to revoke";
      setError(message);
      toast.error("Couldn't revoke invitation", { description: message });
    }
    setRevokingId(null);
  };

  const pending = invitations.filter((i) => !i.acceptedAt);
  const accepted = invitations.filter((i) => i.acceptedAt);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite someone</CardTitle>
          <CardDescription>
            They&apos;ll be able to sign up with this exact email at{" "}
            <code className="text-xs">/sign-up</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex gap-2 flex-col sm:flex-row">
            <div className="relative flex-1">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="email"
                className="pl-9"
                placeholder="person@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                aria-label="Email to invite"
              />
            </div>
            <Button type="submit" disabled={submitting || !email.trim()} className="gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Invite
            </Button>
          </form>
          {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              No pending invitations.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {pending.map((inv) => (
              <Card key={inv.id}>
                <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{inv.email}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Clock className="h-3 w-3" />
                      Invited {formatDistanceToNow(new Date(inv.createdAt))}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="secondary" className="text-xs">Pending</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revoke(inv.id, inv.email)}
                      disabled={revokingId === inv.id}
                      aria-label={`Revoke invitation for ${inv.email}`}
                    >
                      {revokingId === inv.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {accepted.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Accepted ({accepted.length})
          </h2>
          <div className="space-y-2">
            {accepted.map((inv) => (
              <Card key={inv.id}>
                <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{inv.email}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <CheckCircle className="h-3 w-3 text-green-500" />
                      Accepted {inv.acceptedAt && formatDistanceToNow(new Date(inv.acceptedAt))}
                    </p>
                  </div>
                  <Badge className="bg-green-500 hover:bg-green-600 text-xs shrink-0">Active</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
