import { ClerkProvider } from "@clerk/nextjs";

// The page's <SignOutButton> needs Clerk's client context; the provider is
// scoped here (not the root layout) so public routes don't ship Clerk's bundle.
export default function NotInvitedLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
