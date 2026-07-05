// Private-company news watch (issue #63).
//
// Deliberately isolated from the public Stock universe: these companies have no
// tickers, prices, signals, alerts, or trading — the feature is a read-only news
// radar. The canonical company list lives here in code; `syncPrivateCompanies`
// mirrors it into the DB idempotently (rows dropped from the seed go inactive,
// keeping their article history). News comes from Google News RSS via the same
// fetch/parse conventions the public news stage uses (see lib/google-news.ts).

import { db } from "@/lib/db";
import { searchGoogleNews, type GoogleNewsArticle } from "@/lib/google-news";
import { processWithBudget } from "@/lib/concurrency";

export type PrivateCompanySeed = {
  name: string;
  /** Google News query override for ambiguous names; default is the quoted name. */
  query?: string;
};

// Canonical watch list. Chime is deliberately absent: it went public as CHYM
// (Nasdaq, June 12 2025), so it belongs to the public Stock universe, not here.
export const PRIVATE_COMPANY_SEED: PrivateCompanySeed[] = [
  { name: "OpenAI" },
  { name: "Anthropic" },
  { name: "xAI", query: `"xAI" Musk OR "xAI" Grok` }, // "xAI" alone matches explainable-AI papers
  { name: "Databricks" },
  { name: "Stripe" },
  { name: "Scale AI" },
  { name: "Anduril" },
  { name: "Perplexity", query: `"Perplexity AI" OR "Perplexity"` },
  { name: "Cognition", query: `"Cognition AI" OR "Cognition Labs" OR "Devin AI"` }, // plain "Cognition" is psychology noise
  { name: "Mistral", query: `"Mistral AI"` }, // plain "Mistral" is a wind
  { name: "Canva" },
  { name: "ByteDance" },
  { name: "Figure AI" },
  { name: "Rippling" },
  { name: "Ramp", query: `"Ramp" fintech OR "Ramp" startup` }, // plain "Ramp" is a road feature
  { name: "Epic Games" },
  { name: "Commonwealth Fusion Systems" },
  { name: "Helion Energy" },
  { name: "Shield AI" },
];

/** Stable DB key for a seed entry: "Commonwealth Fusion Systems" → "commonwealth-fusion-systems". */
export function privateCompanySlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Google News query for a seed entry: the explicit override, else the quoted name. */
export function privateCompanyQuery(seed: PrivateCompanySeed): string {
  return seed.query ?? `"${seed.name.replace(/\s+/g, " ").trim()}"`;
}

/**
 * Drop batch-internal URL duplicates (Google News can return the same story
 * under multiple query terms); the DB's [companyId, url] unique + skipDuplicates
 * handles cross-run dedupe.
 */
export function dedupeArticles(articles: GoogleNewsArticle[]): GoogleNewsArticle[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

/**
 * Mirror the canonical seed list into the DB. Idempotent: upserts each seed by
 * slug (refreshing name/query and re-activating), then deactivates rows that
 * left the seed — their article history is kept, they just stop being fetched
 * and shown.
 */
export async function syncPrivateCompanies(): Promise<void> {
  const slugs = PRIVATE_COMPANY_SEED.map((s) => privateCompanySlug(s.name));
  for (const seed of PRIVATE_COMPANY_SEED) {
    const slug = privateCompanySlug(seed.name);
    const data = { name: seed.name, query: seed.query ?? null, active: true };
    await db.privateCompany.upsert({
      where: { slug },
      create: { slug, ...data },
      update: data,
    });
  }
  await db.privateCompany.updateMany({
    where: { slug: { notIn: slugs }, active: true },
    data: { active: false },
  });
}

// How far back each run looks. Matches the dashboard's 14-day activity window;
// re-fetching an overlapping window is free because inserts are deduped.
const FETCH_WINDOW_DAYS = 14;
const CONCURRENCY = 4;
const STAGE_BUDGET_MS = Number(process.env.PIPELINE_STAGE_BUDGET_MS) || 240_000;

export type PrivateCompaniesStageResult = {
  stage: "private-companies";
  attempted: number;
  created: number;
  remaining: number;
  done: boolean;
  errors: string[];
};

/**
 * Pipeline stage: sync the canonical company list, then fetch + store recent
 * Google News for every active company. Idempotent (URL-deduped inserts) and
 * budget-bounded like the other stages; per-company failures are recorded,
 * never thrown.
 */
export async function runPrivateCompaniesStage(): Promise<PrivateCompaniesStageResult> {
  const errors: string[] = [];
  let created = 0;

  try {
    await syncPrivateCompanies();
  } catch (e) {
    // Without a synced list the fetch loop may run on a stale set — still useful.
    errors.push(`Private-company sync failed: ${String(e)}`);
  }

  const since = new Date(Date.now() - FETCH_WINDOW_DAYS * 86_400_000);
  const companies = await db.privateCompany.findMany({
    where: { active: true },
    select: { id: true, name: true, query: true },
  });

  const outcome = await processWithBudget(
    companies,
    async (company) => {
      try {
        const query = company.query ?? privateCompanyQuery({ name: company.name });
        const articles = dedupeArticles(await searchGoogleNews(query, since));
        if (articles.length === 0) return;
        const res = await db.privateCompanyArticle.createMany({
          data: articles.map((a) => ({
            companyId: company.id,
            headline: a.title,
            url: a.url,
            source: a.source,
            publishedAt: a.publishedAt,
          })),
          skipDuplicates: true,
        });
        created += res.count;
      } catch (e) {
        errors.push(`Private-company news failed for ${company.name}: ${String(e)}`);
      }
    },
    { concurrency: CONCURRENCY, deadline: Date.now() + STAGE_BUDGET_MS }
  );

  return {
    stage: "private-companies",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    errors,
  };
}
