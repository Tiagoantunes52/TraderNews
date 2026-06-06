import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SiteHeader } from "@/components/landing/site-header";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { HowItWorks } from "@/components/landing/how-it-works";
import { CallToAction } from "@/components/landing/cta";
import { SiteFooter } from "@/components/landing/site-footer";

export default async function Home() {
  // Preserve existing behavior: signed-in users go straight to the dashboard.
  // Logged-out visitors get the marketing landing page below.
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <Features />
        <HowItWorks />
        <CallToAction />
      </main>
      <SiteFooter />
    </>
  );
}
