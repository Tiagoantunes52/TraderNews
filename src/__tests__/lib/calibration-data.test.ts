import { describe, it, expect } from "vitest";
import { snapshotInput, type CalibrationReport } from "@/lib/calibration-data";

// Minimal report — only the fields snapshotInput reads need to be real; the rest is
// cast away so the test isn't coupled to the full report shape.
const report = {
  monthsCoverage: 1.6,
  horizons: [
    { horizon: 1, ic: { combined: 0.01, sentiment: null, quant: null } },
    { horizon: 5, ic: { combined: 0.042, sentiment: null, quant: null } },
  ],
  gatedBook: "SIM_COMBINED",
  closedTrades: 7,
  alpha: { alpha: 0.001, beta: 1.1, alphaAnnualized: 0.25, alphaT: 1.4 },
  edge: { n: 7, meanNet: 0.012, tStat: 0.9, meanNetStressed: 0.004 },
  gate: { status: "INSUFFICIENT_DATA", checks: [] },
} as unknown as CalibrationReport;

describe("snapshotInput", () => {
  it("promotes the headline fields, pulling IC from the gate horizon (5d)", () => {
    const row = snapshotInput(report, new Date("2026-06-19T00:00:00.000Z"));
    expect(row.gateStatus).toBe("INSUFFICIENT_DATA");
    expect(row.gatedBook).toBe("SIM_COMBINED");
    expect(row.monthsCoverage).toBe(1.6);
    expect(row.closedTrades).toBe(7);
    expect(row.edgeMean).toBe(0.012);
    expect(row.edgeTStat).toBe(0.9);
    expect(row.alphaTStat).toBe(1.4);
    expect(row.combinedIc).toBe(0.042);
    expect(row.date.toISOString()).toBe("2026-06-19T00:00:00.000Z");
  });

  it("tolerates a null alpha", () => {
    const row = snapshotInput({ ...report, alpha: null } as CalibrationReport, new Date());
    expect(row.alphaTStat).toBeNull();
  });
});
