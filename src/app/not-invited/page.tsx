import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@clerk/nextjs";
import { Mail } from "lucide-react";

export const metadata = {
  title: "Invitation required — TraderNews",
};

export default function NotInvitedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-2">
            <Mail className="h-5 w-5 text-muted-foreground" />
          </div>
          <CardTitle className="text-center">Invitation required</CardTitle>
          <CardDescription className="text-center">
            TraderNews is invite-only. Your email isn&apos;t on the guest list yet — ask an admin to send you an invitation, then sign in again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton redirectUrl="/sign-in">
            <Button variant="outline" className="w-full">Sign out</Button>
          </SignOutButton>
        </CardContent>
      </Card>
    </div>
  );
}
