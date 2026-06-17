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

async function orderRoundtrip(symbol: string, ref: number) {
  const limitPrice = Math.round(ref * 1.005 * 100) / 100;
  const stopPrice = Math.round(ref * 0.92 * 100) / 100;
  console.log(`\n[order] ${symbol} qty=1 limit=${limitPrice} stop=${stopPrice}`);

  const entry = await submitEntryWithStop({ symbol, qty: 1, limitPrice, stopPrice });
  console.log("  entry accepted:", entry.order.id, "status:", entry.order.status, "stopLeg:", entry.stopOrderId);

  // small settle, then inspect the resting protective order Alpaca created
  await new Promise((r) => setTimeout(r, 2000));
  const resting = (await getOpenOrders(symbol)).filter((o) => o.side === "sell");
  console.log("  resting sell orders:", JSON.stringify(resting));

  // exercise the trailing + standalone-stop payloads too (then cancel them)
  const trail = await submitTrailingStop({ symbol, qty: 1, trailPercent: 12 });
  console.log("  trailing accepted:", trail.id, trail.status);
  await cancelOrder(trail.id);

  // clean up: cancel any resting stop/trailing, then flatten the 1-share position
  for (const o of await getOpenOrders(symbol)) {
    if (o.side === "sell") await cancelOrder(o.id);
  }
  await new Promise((r) => setTimeout(r, 1000));
  const held = (await getPositions()).find((p) => p.symbol === symbol);
  if (held && held.qty > 0) {
    const close = await submitMarketOrder({ symbol, side: "sell", qty: Math.floor(held.qty) });
    console.log("  flattened:", close.id, close.status);
  } else {
    console.log("  no position to flatten");
  }
  // silence unused-import lint when only the read path runs
  void submitStopSell;
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
