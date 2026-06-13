import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Control the HTTP layer so we can drive AInvest's paginated envelope directly
// (the issue calls for vi.mock("@/lib/http")).
vi.mock("@/lib/http", () => ({ fetchWithRetry: vi.fn() }));

import { fetchWithRetry } from "@/lib/http";
import {
  normalizeCongressTxnType,
  sanitizeExternalUrl,
  parseCongressDate,
  buildCongressDedupKey,
  mapAinvestRow,
  isCongressEligible,
  getCongressTrades,
} from "@/lib/congress-trades";

const mockFetch = vi.mocked(fetchWithRetry);

/** AInvest envelope: { status_code, status_msg, data: { data: [...] } }. */
function page(rows: unknown[], status_code = 0) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status_code, status_msg: status_code === 0 ? "success" : "err", data: { data: rows } }),
  } as unknown as Response;
}

const RAW = {
  name: "Nancy Example",
  party: "Democrat",
  state: "CA",
  trade_date: "2026-05-20",
  filing_date: "2026-06-02",
  reporting_gap: "13 Days",
  trade_type: "buy",
  size: "$100K-$250K",
};

describe("normalizeCongressTxnType", () => {
  it("maps AInvest's buy/sell and tolerates richer synonyms", () => {
    expect(normalizeCongressTxnType("buy")).toBe("PURCHASE");
    expect(normalizeCongressTxnType("Purchase")).toBe("PURCHASE");
    expect(normalizeCongressTxnType("sell")).toBe("SALE");
    expect(normalizeCongressTxnType("Sale (Partial)")).toBe("SALE");
    expect(normalizeCongressTxnType("exchange")).toBe("EXCHANGE");
  });

  it("falls back to OTHER for unknown/empty", () => {
    expect(normalizeCongressTxnType("receive")).toBe("OTHER");
    expect(normalizeCongressTxnType("")).toBe("OTHER");
    expect(normalizeCongressTxnType(null)).toBe("OTHER");
  });
});

describe("isCongressEligible", () => {
  it("allows US equities, ETFs and class shares but not crypto", () => {
    expect(isCongressEligible("AAPL")).toBe(true);
    expect(isCongressEligible("SPY")).toBe(true); // ETFs DO get traded by Congress
    expect(isCongressEligible("BRK.B")).toBe(true); // class share
    expect(isCongressEligible("BTC-USD")).toBe(false); // no congress data for crypto
  });
});

describe("sanitizeExternalUrl", () => {
  it("accepts http(s) and rejects dangerous or malformed schemes", () => {
    expect(sanitizeExternalUrl("https://disclosures-clerk.house.gov/x.pdf")).toBe(
      "https://disclosures-clerk.house.gov/x.pdf"
    );
    expect(sanitizeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeExternalUrl("data:text/html,<script>")).toBeNull();
    expect(sanitizeExternalUrl("not a url")).toBeNull();
    expect(sanitizeExternalUrl(null)).toBeNull();
    expect(sanitizeExternalUrl("")).toBeNull();
  });
});

describe("parseCongressDate", () => {
  it("parses ISO and US date formats as UTC", () => {
    expect(parseCongressDate("2026-05-20")?.toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(parseCongressDate("05/20/2026")?.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("rejects junk and out-of-range values", () => {
    expect(parseCongressDate("--")).toBeNull();
    expect(parseCongressDate("2026-13-40")).toBeNull();
    expect(parseCongressDate(null)).toBeNull();
    expect(parseCongressDate("")).toBeNull();
  });
});

describe("mapAinvestRow", () => {
  it("normalizes a raw row, carrying party/state and mapping the side", () => {
    const r = mapAinvestRow("AAPL", RAW)!;
    expect(r.politician).toBe("Nancy Example");
    expect(r.party).toBe("Democrat");
    expect(r.state).toBe("CA");
    expect(r.txnType).toBe("PURCHASE");
    expect(r.amountRange).toBe("$100K-$250K");
    expect(r.transactionDate.toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(r.disclosureDate.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    expect(r.owner).toBeNull(); // not supplied by AInvest
    expect(r.ptrLink).toBeNull();
  });

  it("falls back disclosureDate to the trade date when filing_date is absent", () => {
    const r = mapAinvestRow("AAPL", { ...RAW, filing_date: undefined })!;
    expect(r.disclosureDate.toISOString()).toBe(r.transactionDate.toISOString());
  });

  it("returns null when the politician name or trade date is unusable", () => {
    expect(mapAinvestRow("AAPL", { ...RAW, name: "  " })).toBeNull();
    expect(mapAinvestRow("AAPL", { ...RAW, trade_date: "--" })).toBeNull();
  });
});

describe("buildCongressDedupKey", () => {
  const d = new Date("2026-05-20T00:00:00Z");

  it("is stable for the same disclosure and value-inclusive across distinct ones", () => {
    const a = buildCongressDedupKey("AAPL", "Nancy Example", d, "buy", "$100K-$250K");
    const b = buildCongressDedupKey("aapl", "  Nancy Example ", d, "BUY", "$100K-$250K");
    expect(a).toBe(b); // case/whitespace-insensitive
    // A different amount (an amended filing) yields a different key.
    expect(buildCongressDedupKey("AAPL", "Nancy Example", d, "buy", "$250K-$500K")).not.toBe(a);
  });
});

describe("getCongressTrades", () => {
  beforeEach(() => {
    process.env.AINVEST_API_KEY = "test-key";
    mockFetch.mockReset();
  });
  afterEach(() => {
    delete process.env.AINVEST_API_KEY;
  });

  it("is a clean no-op (no fetch, no error) when unconfigured", async () => {
    delete process.env.AINVEST_API_KEY;
    const { trades, error } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(trades).toEqual([]);
    expect(error).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps only in-window rows and sends the bearer token + ticker", async () => {
    mockFetch.mockResolvedValueOnce(
      page([
        { ...RAW, trade_date: "2026-05-20" }, // in window
        { ...RAW, trade_date: "2025-11-01", size: "$1K-$15K" }, // before `since` → dropped
      ])
    );
    const { trades, error } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(error).toBeNull();
    expect(trades).toHaveLength(1);
    expect(trades[0].transactionDate.getUTCFullYear()).toBe(2026);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url.toString()).toContain("ticker=AAPL");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("walks pages while full+in-window and stops once a page is entirely older", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      ...RAW,
      name: `Rep ${i}`,
      trade_date: "2026-05-20",
    }));
    const stale = Array.from({ length: 50 }, (_, i) => ({
      ...RAW,
      name: `Old ${i}`,
      trade_date: "2025-01-01",
    }));
    mockFetch.mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page(stale));

    const { trades } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(trades).toHaveLength(50); // only the in-window page
  });

  it("collapses duplicate disclosures within a response", async () => {
    mockFetch.mockResolvedValueOnce(page([RAW, { ...RAW }]));
    const { trades } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(trades).toHaveLength(1);
  });

  it("degrades to an error string instead of throwing on transport failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const { trades, error } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(trades).toEqual([]);
    expect(error).toContain("Congress fetch failed for AAPL");
  });

  it("treats a non-zero AInvest status_code as a failure", async () => {
    mockFetch.mockResolvedValueOnce(page([], 4012));
    const { error } = await getCongressTrades("AAPL", new Date("2026-01-01"));
    expect(error).toContain("AInvest status 4012");
  });
});
