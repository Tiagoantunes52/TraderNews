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
import { BarChart2, Calculator, LayoutDashboard, Newspaper, Star, Settings, TrendingUp, Shield, Briefcase, UserSearch, LineChart } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const baseNavItems = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "News Feed", href: "/dashboard/news", icon: Newspaper },
  { label: "Markets", href: "/dashboard/markets", icon: TrendingUp },
  { label: "Watchlist", href: "/dashboard/watchlist", icon: Star },
  { label: "Sentiment", href: "/dashboard/sentiment", icon: BarChart2 },
  { label: "Insider", href: "/dashboard/insider", icon: UserSearch },
  { label: "Analysis", href: "/dashboard/analysis", icon: Calculator },
  { label: "Portfolio", href: "/dashboard/portfolio", icon: Briefcase },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
];

// Admin-only. Signal Performance is an operator view (it drives a single shared
// Alpaca paper account), so it lives behind the same gate as Admin.
const adminNavItems = [
  { label: "Performance", href: "/dashboard/performance", icon: LineChart },
  { label: "Admin", href: "/dashboard/admin", icon: Shield },
];

export function AppSidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const navItems = isAdmin ? [...baseNavItems, ...adminNavItems] : baseNavItems;

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
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  item.href === "/dashboard"
                    ? pathname === item.href
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-4 py-3 text-xs text-muted-foreground">
        TraderNews © 2026
      </SidebarFooter>
    </Sidebar>
  );
}
