import { redirect } from "next/navigation";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import { PipelineStatusBadge } from "@/components/pipeline-status-badge";
import { UserButton } from "@clerk/nextjs";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { db } from "@/lib/db";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getOrCreateUser();
  if (!user) redirect("/not-invited");

  const isAdmin = user.role === "ADMIN";

  const lastSentiment = await db.sentiment.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });

  return (
    <SidebarProvider>
      <AppSidebar isAdmin={isAdmin} />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <span className="font-semibold text-sm">TraderNews</span>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <PipelineStatusBadge lastRun={lastSentiment?.date ?? null} isAdmin={isAdmin} />
            <ThemeToggle />
            <UserButton />
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
