"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { BarChart2, Calculator, LayoutDashboard, Newspaper, Star, Settings, TrendingUp, Shield, Compass, UserSearch, LineChart, Briefcase } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { label: string; href: string; icon: typeof LayoutDashboard; adminOnly?: boolean };
type NavSection = { label: string; items: NavItem[]; adminOnly?: boolean };

// Cross-cutting summary of everything — sits ungrouped above the sections.
const overviewItem: NavItem = { label: "Overview", href: "/dashboard", icon: LayoutDashboard };

// The nav is grouped to make the app's two halves obvious at a glance: research
// (gather data → form a view) vs trading (act on the signals + measure them).
// "Trading" is admin-only because Signal Performance drives a single shared Alpaca
// paper account; the section (and the Admin item) only render for admins. Sections
// that empty out for non-admins are dropped, so the structure stays coherent.
const navSections: NavSection[] = [
  {
    label: "Market Research",
    items: [
      { label: "News Feed", href: "/dashboard/news", icon: Newspaper },
      { label: "Markets", href: "/dashboard/markets", icon: TrendingUp },
      { label: "Watchlist", href: "/dashboard/watchlist", icon: Star },
      { label: "Sentiment", href: "/dashboard/sentiment", icon: BarChart2 },
      { label: "Insider", href: "/dashboard/insider", icon: UserSearch },
    ],
  },
  {
    label: "Signals",
    items: [
      { label: "Analysis", href: "/dashboard/analysis", icon: Calculator },
      { label: "Watchlist Insights", href: "/dashboard/insights", icon: Compass },
    ],
  },
  {
    label: "Automated Trading",
    adminOnly: true,
    items: [
      { label: "Portfolio", href: "/dashboard/portfolio", icon: Briefcase },
      { label: "Performance", href: "/dashboard/performance", icon: LineChart },
    ],
  },
  {
    label: "Account",
    items: [
      { label: "Settings", href: "/dashboard/settings", icon: Settings },
      { label: "Admin", href: "/dashboard/admin", icon: Shield, adminOnly: true },
    ],
  },
];

export function AppSidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.href}>
      <SidebarMenuButton asChild isActive={isActive(item.href)}>
        <Link href={item.href}>
          <item.icon className="h-4 w-4" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  const visibleSections = navSections
    .filter((s) => isAdmin || !s.adminOnly)
    .map((s) => ({ ...s, items: s.items.filter((i) => isAdmin || !i.adminOnly) }))
    .filter((s) => s.items.length > 0);

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <span className="font-bold text-base">TraderNews</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{renderItem(overviewItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {visibleSections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{section.items.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="px-4 py-3 text-xs text-muted-foreground">
        TraderNews © 2026
      </SidebarFooter>
    </Sidebar>
  );
}
