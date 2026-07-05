import { ClerkProvider } from "@clerk/nextjs";

// The <SignIn>/<SignUp> pages need Clerk's client context; the provider is
// scoped here (not the root layout) so public routes don't ship Clerk's bundle.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
