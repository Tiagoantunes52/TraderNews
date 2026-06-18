import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isCrossOriginMutation } from "@/lib/csrf";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  // CSRF defence-in-depth (#23): block cross-origin state-changing API calls before
  // they reach a handler (and before Clerk auth), on top of the SameSite=Lax cookie.
  if (isCrossOriginMutation(req.method, req.nextUrl.pathname, req.headers.get("origin"), req.headers.get("host"))) {
    return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }

  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
