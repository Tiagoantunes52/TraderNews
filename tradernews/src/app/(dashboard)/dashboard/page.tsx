import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper, TrendingUp, TrendingDown, Minus } from "lucide-react";

function SentimentBadge({ score }: { score: number }) {
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600"><TrendingUp className="h-3 w-3 mr-1" />Bullish</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600"><TrendingDown className="h-3 w-3 mr-1" />Bearish</Badge>;
  return <Badge variant="secondary"><Minus className="h-3 w-3 mr-1" />Neutral</Badge>;
}

const placeholderArticles = [
  { id: 1, headline: "Fed signals potential rate cuts amid cooling inflation data", source: "Reuters", publishedAt: "2h ago", stocks: ["SPY", "QQQ"], sentimentScore: 0.6 },
  { id: 2, headline: "Apple reports record Q1 earnings, beats analyst estimates", source: "Bloomberg", publishedAt: "4h ago", stocks: ["AAPL"], sentimentScore: 0.8 },
  { id: 3, headline: "Oil prices drop as OPEC+ considers output increase", source: "FT", publishedAt: "5h ago", stocks: ["XOM", "CVX"], sentimentScore: -0.5 },
  { id: 4, headline: "Tesla misses delivery targets for second consecutive quarter", source: "WSJ", publishedAt: "6h ago", stocks: ["TSLA"], sentimentScore: -0.7 },
  { id: 5, headline: "Microsoft Azure growth steady at 28% year-over-year", source: "CNBC", publishedAt: "8h ago", stocks: ["MSFT"], sentimentScore: 0.3 },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">News Feed</h1>
        <p className="text-muted-foreground text-sm mt-1">Latest market news with AI sentiment analysis</p>
      </div>

      <div className="grid gap-3">
        {placeholderArticles.map((article) => (
          <Card key={article.id} className="hover:bg-muted/50 transition-colors cursor-pointer">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-4">
                <CardTitle className="text-base font-medium leading-snug">
                  {article.headline}
                </CardTitle>
                <SentimentBadge score={article.sentimentScore} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Newspaper className="h-3 w-3" />
                  {article.source}
                </span>
                <span>·</span>
                <span>{article.publishedAt}</span>
                <span>·</span>
                <div className="flex gap-1">
                  {article.stocks.map((ticker) => (
                    <Badge key={ticker} variant="outline" className="text-xs px-1.5 py-0">
                      {ticker}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
