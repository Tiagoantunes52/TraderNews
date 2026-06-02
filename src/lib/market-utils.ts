export function marketNamesForTicker(ticker: string): string[] {
  if (ticker.endsWith(".LS")) return ["EURONEXT_LISBON"];
  if (ticker.endsWith(".L"))  return ["LSE"];
  if (ticker.endsWith(".PA")) return ["EURONEXT_PARIS"];
  if (ticker.endsWith(".DE")) return ["XETRA"];
  if (ticker.endsWith(".AS")) return ["EURONEXT_AMSTERDAM"];
  if (ticker.endsWith(".MC")) return ["BME"];
  if (ticker.endsWith(".MI")) return ["BORSA_ITALIANA"];
  if (ticker.endsWith("-USD")) return ["CRYPTO"];
  return ["NYSE", "NASDAQ"];
}
