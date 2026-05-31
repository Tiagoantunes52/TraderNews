import { describe, it, expect } from "vitest";
import { isAdmin } from "@/lib/auth";
import type { AppUser } from "@/lib/auth";

function makeUser(role: "USER" | "ADMIN"): AppUser {
  return { id: "1", clerkId: "clerk_1", email: "a@b.com", role, createdAt: new Date() } as AppUser;
}

describe("isAdmin()", () => {
  it("returns true for ADMIN role", () => {
    expect(isAdmin(makeUser("ADMIN"))).toBe(true);
  });

  it("returns false for USER role", () => {
    expect(isAdmin(makeUser("USER"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAdmin(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAdmin(undefined)).toBe(false);
  });
});
