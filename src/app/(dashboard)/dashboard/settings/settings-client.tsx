"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useUser, SignOutButton } from "@clerk/nextjs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RefreshCw, LogOut, CheckCircle, XCircle, Loader2, ShieldCheck } from "lucide-react";

type PipelineStatus = "idle" | "running" | "success" | "error";
type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  errors: string[];
};

export function SettingsClient({ isAdmin }: { isAdmin: boolean }) {
  const { user } = useUser();
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("idle");
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  const runPipeline = async () => {
    setPipelineStatus("running");
    setPipelineResult(null);
    setPipelineError(null);
    try {
      const res = await fetch("/api/pipeline/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Pipeline failed");
      setPipelineResult(data);
      setPipelineStatus("success");
      toast.success("Pipeline finished", {
        description: `${data.articles.saved} new articles, ${data.sentiments} sentiment readings`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPipelineError(message);
      setPipelineStatus("error");
      toast.error("Pipeline failed", { description: message });
    }
  };

  const initials = user?.fullName
    ? user.fullName.split(" ").map((n) => n[0]).join("").toUpperCase()
    : user?.emailAddresses[0]?.emailAddress?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your account and app preferences</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your profile information from Clerk</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-14 w-14">
              <AvatarImage src={user?.imageUrl} />
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium truncate">{user?.fullName ?? "—"}</p>
                {isAdmin && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <ShieldCheck className="h-3 w-3" /> Admin
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground truncate">
                {user?.emailAddresses[0]?.emailAddress}
              </p>
            </div>
          </div>
          <Separator />
          <SignOutButton redirectUrl="/sign-in">
            <Button variant="outline" className="w-full gap-2">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </SignOutButton>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>News Pipeline</CardTitle>
            <CardDescription>
              Manually trigger a news fetch and sentiment analysis for the watchlist stocks.
              Runs automatically every 6 hours in production.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={runPipeline}
              disabled={pipelineStatus === "running"}
              className="w-full gap-2"
            >
              {pipelineStatus === "running" ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Running pipeline...</>
              ) : (
                <><RefreshCw className="h-4 w-4" />Run pipeline now</>
              )}
            </Button>

            {pipelineStatus === "success" && pipelineResult && (
              <div className="rounded-lg bg-muted p-4 space-y-2">
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400 font-medium text-sm">
                  <CheckCircle className="h-4 w-4" />
                  Pipeline completed
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {[
                    { label: "Fetched", value: pipelineResult.articles.fetched },
                    { label: "Saved", value: pipelineResult.articles.saved },
                    { label: "Sentiments", value: pipelineResult.sentiments },
                  ].map((stat) => (
                    <div key={stat.label} className="text-center">
                      <p className="text-2xl font-bold">{stat.value}</p>
                      <p className="text-xs text-muted-foreground">{stat.label}</p>
                    </div>
                  ))}
                </div>
                {pipelineResult.errors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {pipelineResult.errors.map((e, i) => (
                      <p key={i} className="text-xs text-red-500">{e}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pipelineStatus === "error" && (
              <div className="rounded-lg bg-muted p-3 flex items-start gap-2 text-red-500 text-sm">
                <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{pipelineError ?? "Pipeline failed."}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>TraderNews</span>
            <Badge variant="outline" className="text-xs">v0.1.0</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
