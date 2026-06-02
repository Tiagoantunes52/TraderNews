import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const markets = [
  { name: "NYSE", description: "New York Stock Exchange" },
  { name: "NASDAQ", description: "National Association of Securities Dealers" },
  { name: "LSE", description: "London Stock Exchange (FTSE 100)" },
  { name: "CRYPTO", description: "Cryptocurrency" },
  { name: "FOREX", description: "Foreign Exchange" },
  { name: "EURONEXT_LISBON", description: "Euronext Lisbon (PSI)" },
  { name: "BME", description: "Bolsa de Madrid (IBEX 35)" },
  { name: "EURONEXT_PARIS", description: "Euronext Paris (CAC 40)" },
  { name: "XETRA", description: "Deutsche Börse XETRA (DAX)" },
  { name: "EURONEXT_AMSTERDAM", description: "Euronext Amsterdam (AEX)" },
  { name: "BORSA_ITALIANA", description: "Borsa Italiana (FTSE MIB)" },
];

type SeedStock = { ticker: string; name: string; market: string };

const usEquities: SeedStock[] = [
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
];

// Crypto — coins covered by our price sources (Binance USDT pairs + CoinGecko ids).
const crypto: SeedStock[] = [
  { ticker: "BTC-USD", name: "Bitcoin", market: "CRYPTO" },
  { ticker: "ETH-USD", name: "Ethereum", market: "CRYPTO" },
  { ticker: "SOL-USD", name: "Solana", market: "CRYPTO" },
  { ticker: "XRP-USD", name: "XRP", market: "CRYPTO" },
  { ticker: "ADA-USD", name: "Cardano", market: "CRYPTO" },
  { ticker: "DOGE-USD", name: "Dogecoin", market: "CRYPTO" },
  { ticker: "AVAX-USD", name: "Avalanche", market: "CRYPTO" },
  { ticker: "DOT-USD", name: "Polkadot", market: "CRYPTO" },
  { ticker: "LTC-USD", name: "Litecoin", market: "CRYPTO" },
  { ticker: "LINK-USD", name: "Chainlink", market: "CRYPTO" },
  { ticker: "BCH-USD", name: "Bitcoin Cash", market: "CRYPTO" },
  { ticker: "TRX-USD", name: "TRON", market: "CRYPTO" },
  { ticker: "XLM-USD", name: "Stellar", market: "CRYPTO" },
  { ticker: "ATOM-USD", name: "Cosmos", market: "CRYPTO" },
];

// Portugal — Euronext Lisbon (PSI). The PSI has ~16 constituents.
const portugal: SeedStock[] = [
  { ticker: "JMT.LS", name: "Jerónimo Martins", market: "EURONEXT_LISBON" },
  { ticker: "GALP.LS", name: "Galp Energia", market: "EURONEXT_LISBON" },
  { ticker: "EDP.LS", name: "EDP — Energias de Portugal", market: "EURONEXT_LISBON" },
  { ticker: "EDPR.LS", name: "EDP Renováveis", market: "EURONEXT_LISBON" },
  { ticker: "BCP.LS", name: "Banco Comercial Português (Millennium BCP)", market: "EURONEXT_LISBON" },
  { ticker: "NOS.LS", name: "NOS SGPS", market: "EURONEXT_LISBON" },
  { ticker: "SON.LS", name: "Sonae SGPS", market: "EURONEXT_LISBON" },
  { ticker: "NVG.LS", name: "The Navigator Company", market: "EURONEXT_LISBON" },
  { ticker: "SEM.LS", name: "Semapa", market: "EURONEXT_LISBON" },
  { ticker: "CTT.LS", name: "CTT — Correios de Portugal", market: "EURONEXT_LISBON" },
  { ticker: "ALTR.LS", name: "Altri SGPS", market: "EURONEXT_LISBON" },
  { ticker: "COR.LS", name: "Corticeira Amorim", market: "EURONEXT_LISBON" },
  { ticker: "EGL.LS", name: "Mota-Engil SGPS", market: "EURONEXT_LISBON" },
  { ticker: "RENE.LS", name: "REN — Redes Energéticas Nacionais", market: "EURONEXT_LISBON" },
  { ticker: "IBS.LS", name: "Ibersol", market: "EURONEXT_LISBON" },
  { ticker: "RAM.LS", name: "Ramada Investimentos", market: "EURONEXT_LISBON" },
];

// Spain — Bolsa de Madrid (IBEX 35), top 20 by weight/liquidity.
const spain: SeedStock[] = [
  { ticker: "ITX.MC", name: "Industria de Diseño Textil (Inditex)", market: "BME" },
  { ticker: "SAN.MC", name: "Banco Santander", market: "BME" },
  { ticker: "IBE.MC", name: "Iberdrola", market: "BME" },
  { ticker: "BBVA.MC", name: "Banco Bilbao Vizcaya Argentaria (BBVA)", market: "BME" },
  { ticker: "TEF.MC", name: "Telefónica", market: "BME" },
  { ticker: "CABK.MC", name: "CaixaBank", market: "BME" },
  { ticker: "AMS.MC", name: "Amadeus IT Group", market: "BME" },
  { ticker: "FER.MC", name: "Ferrovial", market: "BME" },
  { ticker: "REP.MC", name: "Repsol", market: "BME" },
  { ticker: "AENA.MC", name: "Aena", market: "BME" },
  { ticker: "ELE.MC", name: "Endesa", market: "BME" },
  { ticker: "NTGY.MC", name: "Naturgy Energy Group", market: "BME" },
  { ticker: "SAB.MC", name: "Banco de Sabadell", market: "BME" },
  { ticker: "RED.MC", name: "Redeia (Red Eléctrica)", market: "BME" },
  { ticker: "CLNX.MC", name: "Cellnex Telecom", market: "BME" },
  { ticker: "ACS.MC", name: "ACS Actividades de Construcción", market: "BME" },
  { ticker: "MAP.MC", name: "Mapfre", market: "BME" },
  { ticker: "ANA.MC", name: "Acciona", market: "BME" },
  { ticker: "ENG.MC", name: "Enagás", market: "BME" },
  { ticker: "GRF.MC", name: "Grifols", market: "BME" },
];

// France — Euronext Paris (CAC 40), top 20 by weight.
const france: SeedStock[] = [
  { ticker: "MC.PA", name: "LVMH Moët Hennessy Louis Vuitton", market: "EURONEXT_PARIS" },
  { ticker: "OR.PA", name: "L'Oréal", market: "EURONEXT_PARIS" },
  { ticker: "TTE.PA", name: "TotalEnergies", market: "EURONEXT_PARIS" },
  { ticker: "SAN.PA", name: "Sanofi", market: "EURONEXT_PARIS" },
  { ticker: "AIR.PA", name: "Airbus", market: "EURONEXT_PARIS" },
  { ticker: "SU.PA", name: "Schneider Electric", market: "EURONEXT_PARIS" },
  { ticker: "AI.PA", name: "Air Liquide", market: "EURONEXT_PARIS" },
  { ticker: "EL.PA", name: "EssilorLuxottica", market: "EURONEXT_PARIS" },
  { ticker: "BNP.PA", name: "BNP Paribas", market: "EURONEXT_PARIS" },
  { ticker: "DG.PA", name: "Vinci", market: "EURONEXT_PARIS" },
  { ticker: "SAF.PA", name: "Safran", market: "EURONEXT_PARIS" },
  { ticker: "CS.PA", name: "AXA", market: "EURONEXT_PARIS" },
  { ticker: "RMS.PA", name: "Hermès International", market: "EURONEXT_PARIS" },
  { ticker: "KER.PA", name: "Kering", market: "EURONEXT_PARIS" },
  { ticker: "DSY.PA", name: "Dassault Systèmes", market: "EURONEXT_PARIS" },
  { ticker: "BN.PA", name: "Danone", market: "EURONEXT_PARIS" },
  { ticker: "GLE.PA", name: "Société Générale", market: "EURONEXT_PARIS" },
  { ticker: "STLAP.PA", name: "Stellantis", market: "EURONEXT_PARIS" },
  { ticker: "ACA.PA", name: "Crédit Agricole", market: "EURONEXT_PARIS" },
  { ticker: "ENGI.PA", name: "Engie", market: "EURONEXT_PARIS" },
];

// Germany — Deutsche Börse XETRA (DAX), top 20 by weight.
const germany: SeedStock[] = [
  { ticker: "SAP.DE", name: "SAP SE", market: "XETRA" },
  { ticker: "SIE.DE", name: "Siemens AG", market: "XETRA" },
  { ticker: "ALV.DE", name: "Allianz SE", market: "XETRA" },
  { ticker: "DTE.DE", name: "Deutsche Telekom AG", market: "XETRA" },
  { ticker: "MBG.DE", name: "Mercedes-Benz Group AG", market: "XETRA" },
  { ticker: "BMW.DE", name: "Bayerische Motoren Werke AG (BMW)", market: "XETRA" },
  { ticker: "VOW3.DE", name: "Volkswagen AG (Pref)", market: "XETRA" },
  { ticker: "BAS.DE", name: "BASF SE", market: "XETRA" },
  { ticker: "BAYN.DE", name: "Bayer AG", market: "XETRA" },
  { ticker: "MRK.DE", name: "Merck KGaA", market: "XETRA" },
  { ticker: "DB1.DE", name: "Deutsche Börse AG", market: "XETRA" },
  { ticker: "IFX.DE", name: "Infineon Technologies AG", market: "XETRA" },
  { ticker: "DBK.DE", name: "Deutsche Bank AG", market: "XETRA" },
  { ticker: "ADS.DE", name: "Adidas AG", market: "XETRA" },
  { ticker: "MUV2.DE", name: "Münchener Rück (Munich Re)", market: "XETRA" },
  { ticker: "RWE.DE", name: "RWE AG", market: "XETRA" },
  { ticker: "EOAN.DE", name: "E.ON SE", market: "XETRA" },
  { ticker: "DHL.DE", name: "DHL Group (Deutsche Post)", market: "XETRA" },
  { ticker: "HEN3.DE", name: "Henkel AG (Pref)", market: "XETRA" },
  { ticker: "P911.DE", name: "Porsche AG", market: "XETRA" },
];

// Netherlands — Euronext Amsterdam (AEX), top 20 by weight.
const netherlands: SeedStock[] = [
  { ticker: "ASML.AS", name: "ASML Holding", market: "EURONEXT_AMSTERDAM" },
  { ticker: "PRX.AS", name: "Prosus", market: "EURONEXT_AMSTERDAM" },
  { ticker: "INGA.AS", name: "ING Groep", market: "EURONEXT_AMSTERDAM" },
  { ticker: "ADYEN.AS", name: "Adyen", market: "EURONEXT_AMSTERDAM" },
  { ticker: "AD.AS", name: "Koninklijke Ahold Delhaize", market: "EURONEXT_AMSTERDAM" },
  { ticker: "PHIA.AS", name: "Koninklijke Philips", market: "EURONEXT_AMSTERDAM" },
  { ticker: "WKL.AS", name: "Wolters Kluwer", market: "EURONEXT_AMSTERDAM" },
  { ticker: "HEIA.AS", name: "Heineken", market: "EURONEXT_AMSTERDAM" },
  { ticker: "ASM.AS", name: "ASM International", market: "EURONEXT_AMSTERDAM" },
  { ticker: "REN.AS", name: "RELX", market: "EURONEXT_AMSTERDAM" },
  { ticker: "BESI.AS", name: "BE Semiconductor Industries", market: "EURONEXT_AMSTERDAM" },
  { ticker: "KPN.AS", name: "Koninklijke KPN", market: "EURONEXT_AMSTERDAM" },
  { ticker: "NN.AS", name: "NN Group", market: "EURONEXT_AMSTERDAM" },
  { ticker: "AGN.AS", name: "Aegon", market: "EURONEXT_AMSTERDAM" },
  { ticker: "DSFIR.AS", name: "DSM-Firmenich", market: "EURONEXT_AMSTERDAM" },
  { ticker: "AKZA.AS", name: "Akzo Nobel", market: "EURONEXT_AMSTERDAM" },
  { ticker: "RAND.AS", name: "Randstad", market: "EURONEXT_AMSTERDAM" },
  { ticker: "IMCD.AS", name: "IMCD", market: "EURONEXT_AMSTERDAM" },
  { ticker: "ABN.AS", name: "ABN AMRO Bank", market: "EURONEXT_AMSTERDAM" },
  { ticker: "URW.AS", name: "Unibail-Rodamco-Westfield", market: "EURONEXT_AMSTERDAM" },
];

// Italy — Borsa Italiana (FTSE MIB), top 20 by weight.
const italy: SeedStock[] = [
  { ticker: "ENEL.MI", name: "Enel", market: "BORSA_ITALIANA" },
  { ticker: "ISP.MI", name: "Intesa Sanpaolo", market: "BORSA_ITALIANA" },
  { ticker: "UCG.MI", name: "UniCredit", market: "BORSA_ITALIANA" },
  { ticker: "ENI.MI", name: "Eni", market: "BORSA_ITALIANA" },
  { ticker: "RACE.MI", name: "Ferrari", market: "BORSA_ITALIANA" },
  { ticker: "G.MI", name: "Assicurazioni Generali", market: "BORSA_ITALIANA" },
  { ticker: "STLAM.MI", name: "Stellantis", market: "BORSA_ITALIANA" },
  { ticker: "STMMI.MI", name: "STMicroelectronics", market: "BORSA_ITALIANA" },
  { ticker: "PRY.MI", name: "Prysmian", market: "BORSA_ITALIANA" },
  { ticker: "MONC.MI", name: "Moncler", market: "BORSA_ITALIANA" },
  { ticker: "TIT.MI", name: "Telecom Italia (TIM)", market: "BORSA_ITALIANA" },
  { ticker: "SRG.MI", name: "Snam", market: "BORSA_ITALIANA" },
  { ticker: "TRN.MI", name: "Terna", market: "BORSA_ITALIANA" },
  { ticker: "LDO.MI", name: "Leonardo", market: "BORSA_ITALIANA" },
  { ticker: "BAMI.MI", name: "Banco BPM", market: "BORSA_ITALIANA" },
  { ticker: "MB.MI", name: "Mediobanca", market: "BORSA_ITALIANA" },
  { ticker: "CPR.MI", name: "Davide Campari-Milano", market: "BORSA_ITALIANA" },
  { ticker: "NEXI.MI", name: "Nexi", market: "BORSA_ITALIANA" },
  { ticker: "PST.MI", name: "Poste Italiane", market: "BORSA_ITALIANA" },
  { ticker: "FBK.MI", name: "FinecoBank", market: "BORSA_ITALIANA" },
];

// United Kingdom — London Stock Exchange (FTSE 100), top 20 by weight.
const uk: SeedStock[] = [
  { ticker: "AZN.L", name: "AstraZeneca", market: "LSE" },
  { ticker: "SHEL.L", name: "Shell", market: "LSE" },
  { ticker: "HSBA.L", name: "HSBC Holdings", market: "LSE" },
  { ticker: "ULVR.L", name: "Unilever", market: "LSE" },
  { ticker: "BP.L", name: "BP", market: "LSE" },
  { ticker: "RIO.L", name: "Rio Tinto", market: "LSE" },
  { ticker: "GSK.L", name: "GSK", market: "LSE" },
  { ticker: "DGE.L", name: "Diageo", market: "LSE" },
  { ticker: "REL.L", name: "RELX", market: "LSE" },
  { ticker: "GLEN.L", name: "Glencore", market: "LSE" },
  { ticker: "BATS.L", name: "British American Tobacco", market: "LSE" },
  { ticker: "LSEG.L", name: "London Stock Exchange Group", market: "LSE" },
  { ticker: "RR.L", name: "Rolls-Royce Holdings", market: "LSE" },
  { ticker: "NG.L", name: "National Grid", market: "LSE" },
  { ticker: "BARC.L", name: "Barclays", market: "LSE" },
  { ticker: "VOD.L", name: "Vodafone Group", market: "LSE" },
  { ticker: "LLOY.L", name: "Lloyds Banking Group", market: "LSE" },
  { ticker: "PRU.L", name: "Prudential", market: "LSE" },
  { ticker: "NWG.L", name: "NatWest Group", market: "LSE" },
  { ticker: "TSCO.L", name: "Tesco", market: "LSE" },
];

const stocks: SeedStock[] = [
  ...usEquities,
  ...crypto,
  ...portugal,
  ...spain,
  ...france,
  ...germany,
  ...netherlands,
  ...italy,
  ...uk,
];

async function main() {
  for (const market of markets) {
    await prisma.market.upsert({
      where: { name: market.name },
      update: { description: market.description },
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

  console.log(`Seeded ${markets.length} markets and ${stocks.length} stocks.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
