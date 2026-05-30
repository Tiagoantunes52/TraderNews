import { NextResponse } from "next/server";
import { getOrCreateUser } from "@/lib/get-or-create-user";

type Awaited<T> = T extends Promise<infer U> ? U : T;
export type AppUser = NonNullable<Awaited<ReturnType<typeof getOrCreateUser>>>;

export function isAdmin(user: AppUser | null | undefined): boolean {
  return user?.role === "ADMIN";
}

/**
 * For route handlers: returns an admin user or a Response (401/403) to return.
 * Usage:
 *   const guard = await requireAdmin();
 *   if (guard instanceof NextResponse) return guard;
 *   const { user } = guard;
 */
export async function requireAdmin(): Promise<NextResponse | { user: AppUser }> {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return { user };
}
