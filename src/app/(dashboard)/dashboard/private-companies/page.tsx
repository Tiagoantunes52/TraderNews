import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper } from "lucide-react";
import { db } from "@/lib/db";
import { formatDistanceToNow } from "@/lib/format-date";
import { safeExternalHref } from "@/lib/normalize";

export const metadata = { title: "Private Companies — TraderNews" };
export const dynamic = "force-dynamic";

// Matches the pipeline stage's fetch window (lib/private-companies.ts).
const ACTIVITY_WINDOW_DAYS = 14;
const HEADLINES_PER_COMPANY = 5;

export default async function PrivateCompaniesPage() {
  // eslint-disable-next-line react-hooks/purity -- server component, fresh render per request
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86_400_000);

  // Global watch list — deliberately not tied to the user's Stock watchlist:
  // private companies have no tickers, signals, or trading (issue #63).
  const companies = await db.privateCompany.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      articles: {
        orderBy: { publishedAt: "desc" },
        take: HEADLINES_PER_COMPANY,
        select: { id: true, headline: true, url: true, source: true, publishedAt: true },
      },
      _count: { select: { articles: { where: { publishedAt: { gte: since } } } } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Private Companies</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          News radar for notable private companies — no tickers, prices, or signals, just what the
          press is saying. Refreshed daily from Google News.
        </p>
      </div>

      {companies.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No companies yet. Run the private-companies pipeline stage to seed the watch list and
            fetch the latest news.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {companies.map((company) => {
            const latest = company.articles[0] ?? null;
            return (
              <Card key={company.id} className="rounded-2xl">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="text-base font-semibold">{company.name}</CardTitle>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="secondary" className="text-xs font-normal">
                        {company._count.articles} in {ACTIVITY_WINDOW_DAYS}d
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {latest ? formatDistanceToNow(latest.publishedAt) : "no articles yet"}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {company.articles.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">
                      Nothing picked up yet — headlines appear after the next pipeline run.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {company.articles.map((article) => (
                        <li key={article.id} className="text-sm leading-snug">
                          <a
                            href={safeExternalHref(article.url)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {article.headline}
                          </a>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                            <span className="flex items-center gap-1">
                              <Newspaper className="h-3 w-3" />
                              {article.source}
                            </span>
                            <span>·</span>
                            <span>{formatDistanceToNow(article.publishedAt)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
