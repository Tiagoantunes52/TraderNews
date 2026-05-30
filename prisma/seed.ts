import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const markets = [
  { name: "NYSE", description: "New York Stock Exchange" },
  { name: "NASDAQ", description: "National Association of Securities Dealers" },
  { name: "LSE", description: "London Stock Exchange" },
  { name: "CRYPTO", description: "Cryptocurrency" },
  { name: "FOREX", description: "Foreign Exchange" },
  { name: "EURONEXT_LISBON", description: "Euronext Lisbon (PSI)" },
];

const stocks = [
  { ticker: "AAPL", name: "Apple Inc.", market: "NASDAQ" },
  { ticker: "MSFT", name: "Microsoft Corporation", market: "NASDAQ" },
  { ticker: "GOOGL", name: "Alphabet Inc.", market: "NASDAQ" },
  { ticker: "AMZN", name: "Amazon.com Inc.", market: "NASDAQ" },
  { ticker: "META", name: "Meta Platforms Inc.", market: "NASDAQ" },
  { ticker: "TSLA", name: "Tesla Inc.", market: "NASDAQ" },
  { ticker: "NVDA", name: "NVIDIA Corporation", market: "NASDAQ" },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", market: "NYSE" },
  { ticker: "V", name: "Visa Inc.", market: "NYSE" },
  { ticker: "JNJ", name: "Johnson & Johnson", market: "NYSE" },
  { ticker: "XOM", name: "Exxon Mobil Corporation", market: "NYSE" },
  { ticker: "SPY", name: "SPDR S&P 500 ETF", market: "NYSE" },
  { ticker: "QQQ", name: "Invesco QQQ Trust", market: "NASDAQ" },
  { ticker: "BTC-USD", name: "Bitcoin", market: "CRYPTO" },
  { ticker: "ETH-USD", name: "Ethereum", market: "CRYPTO" },
  { ticker: "EGL.LS",  name: "Greenvolt — Energias Renováveis",  market: "EURONEXT_LISBON" },
  { ticker: "BCP.LS",  name: "Millennium BCP",                   market: "EURONEXT_LISBON" },
  { ticker: "GALP.LS", name: "Galp Energia",                     market: "EURONEXT_LISBON" },
  { ticker: "EDP.LS",  name: "EDP — Energias de Portugal",       market: "EURONEXT_LISBON" },
  { ticker: "JMT.LS",  name: "Jerónimo Martins",                 market: "EURONEXT_LISBON" },
  { ticker: "NOS.LS",  name: "NOS SGPS",                         market: "EURONEXT_LISBON" },
];

async function main() {
  for (const market of markets) {
    await prisma.market.upsert({
      where: { name: market.name },
      update: {},
      create: market,
    });
  }

  for (const stock of stocks) {
    const market = await prisma.market.findUnique({ where: { name: stock.market } });
    if (!market) continue;
    await prisma.stock.upsert({
      where: { ticker: stock.ticker },
      update: { name: stock.name, marketId: market.id },
      create: { ticker: stock.ticker, name: stock.name, marketId: market.id },
    });
  }

  console.log("Seeded markets and stocks.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
