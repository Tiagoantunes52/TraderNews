// Smoke-test the Alpaca paper Trading client against the real paper account.
// Read-only by default (no orders): `npx tsx --env-file=.env scripts/alpaca-smoke.ts`
// Full order round-trip:            `... scripts/alpaca-smoke.ts order <SYMBOL> <refPrice>`
//   → places a 1-share marketable-limit buy + GTC stop (OTO), verifies the resting
//     stop, then cancels the stop and sells the share to flatten. Needs the market
//     open to fill. This is a *paper* account, so no real money is involved.
import {
  isPaperTradingConfigured,
  getClock,
  getAccount,
  getPositions,
  getOpenOrders,
  submitEntryWithStop,
  submitStopSell,
  submitTrailingStop,
  cancelOrder,
  submitMarketOrder,
} from "../src/lib/alpaca-trading";

async function readOnly() {
  console.log("configured:", isPaperTradingConfigured());
  console.log("clock:      ", await getClock());
  console.log("account:    ", await getAccount());
  const pos = await getPositions();
  console.log("positions:  ", pos.length, JSON.stringify(pos.slice(0, 8)));
  const open = await getOpenOrders();
  console.log("openOrders: ", open.length, JSON.stringify(open.slice(0, 8)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (v: number) => Math.round(v * 100) / 100;

async function orderRoundtrip(symbol: string, cliRef: number) {
  // Use the live current price of a HELD symbol so the limit is genuinely marketable
  // and the stop is validly below market. Fall back to the CLI ref if not held.
  const heldBefore = (await getPositions()).find((p) => p.symbol === symbol);
  const qtyBefore = heldBefore?.qty ?? 0;
  const ref = heldBefore?.currentPrice ?? cliRef;
  const limitPrice = round2(ref * 1.005); // marketable: fills at market, capped here
  const stopPrice = round2(ref * 0.92); // 8% below — comfortably under market

  console.log(`\n[order] ${symbol} ref=${ref} buy 1 limit=${limitPrice} stop=${stopPrice} (qtyBefore=${qtyBefore})`);

  // 1) entry + attached GTC stop (OTO)
  const entry = await submitEntryWithStop({ symbol, qty: 1, limitPrice, stopPrice });
  console.log("  ENTRY:", entry.order.id, entry.order.status, "stopLeg:", entry.stopOrderId);
  await sleep(2500);
  console.log("  resting sells after entry:", JSON.stringify((await getOpenOrders(symbol)).filter((o) => o.side === "sell")));

  // 2) standalone GTC stop-sell (the REPAIR payload)
  const standalone = await submitStopSell({ symbol, qty: 1, stopPrice: round2(ref * 0.9) });
  console.log("  STOP_SELL:", standalone.id, standalone.status);

  // 3) trailing stop (the ARM_TRAILING payload)
  const trail = await submitTrailingStop({ symbol, qty: 1, trailPercent: 12 });
  console.log("  TRAILING:", trail.id, trail.status);

  // 4) cancel everything I placed (all sells; the account had 0 open orders before)
  for (const o of await getOpenOrders(symbol)) {
    if (o.side === "sell") await cancelOrder(o.id);
  }
  console.log("  canceled all resting sells");

  // flatten ONLY the shares I added — leave the pre-existing position untouched
  await sleep(1500);
  const qtyAfter = (await getPositions()).find((p) => p.symbol === symbol)?.qty ?? 0;
  const delta = Math.round((qtyAfter - qtyBefore) * 1e6) / 1e6;
  console.log(`  qtyAfter=${qtyAfter} delta=${delta}`);
  if (delta > 0) {
    const close = await submitMarketOrder({ symbol, side: "sell", qty: delta });
    console.log("  FLATTENED my add:", close.id, close.status, "qty", delta);
  } else {
    console.log("  buy didn't fill / nothing to flatten");
  }
}

(async () => {
  try {
    await readOnly();
    if (process.argv[2] === "order") {
      const symbol = process.argv[3];
      const ref = Number(process.argv[4]);
      if (!symbol || !Number.isFinite(ref)) throw new Error("usage: order <SYMBOL> <refPrice>");
      await orderRoundtrip(symbol, ref);
      console.log("\n[order] round-trip complete; re-checking open orders:");
      console.log("openOrders:", JSON.stringify(await getOpenOrders()));
    }
  } catch (e) {
    console.error("SMOKE_ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
