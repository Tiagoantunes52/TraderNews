import { describe, it, expect } from "vitest";
import { pickFinding, NON_CODE_CODES } from "@/lib/pick-finding";
import { type Finding, type Severity } from "@/lib/daily-review";

const f = (severity: Severity, code: string): Finding => ({
  severity,
  code,
  title: `${code} title`,
  detail: `${code} detail`,
});

describe("pickFinding", () => {
  it("prefers fail over warn", () => {
    const chosen = pickFinding([f("warn", "ENTRY_BELOW_DEADBAND"), f("fail", "MISSED_EXIT")], []);
    expect(chosen?.code).toBe("MISSED_EXIT");
  });

  it("drops info findings even when they'd sort first alphabetically", () => {
    const chosen = pickFinding([f("info", "AAA_INFO"), f("warn", "ENTRY_BELOW_CONFIDENCE")], []);
    expect(chosen?.code).toBe("ENTRY_BELOW_CONFIDENCE");
  });

  it("skips every non-code (operational/broker/tuning) code", () => {
    for (const code of NON_CODE_CODES) {
      // Even at fail severity, a non-code finding is never chosen when it's the only one.
      expect(pickFinding([f("fail", code)], [])).toBeNull();
    }
  });

  it("chooses code-addressable correctness findings", () => {
    for (const code of ["MISSED_EXIT", "REPLAY_TYPE_MISMATCH", "REALIZED_PNL_MISMATCH", "EXIT_STOP_ABOVE_TRIGGER"]) {
      expect(pickFinding([f("fail", code)], [])?.code).toBe(code);
    }
  });

  it("skips codes already handled by an open/recent PR and falls through to the next", () => {
    const findings = [f("fail", "MISSED_EXIT"), f("fail", "REALIZED_PNL_MISMATCH")];
    expect(pickFinding(findings, ["MISSED_EXIT"])?.code).toBe("REALIZED_PNL_MISMATCH");
  });

  it("returns null when every finding is filtered out", () => {
    expect(pickFinding([f("fail", "MISSED_EXIT")], ["MISSED_EXIT"])).toBeNull();
    expect(pickFinding([f("info", "TUNE_STOP_DISTANCE"), f("fail", "NO_QUANT")], [])).toBeNull();
    expect(pickFinding([], [])).toBeNull();
  });

  it("breaks severity ties deterministically by code ascending", () => {
    const chosen = pickFinding([f("fail", "REPLAY_TYPE_MISMATCH"), f("fail", "EXIT_TRAIL_NOT_ARMED")], []);
    // Both fail; "EXIT_..." < "REPLAY_..." so it wins regardless of input order.
    expect(chosen?.code).toBe("EXIT_TRAIL_NOT_ARMED");
    const reversed = pickFinding([f("fail", "EXIT_TRAIL_NOT_ARMED"), f("fail", "REPLAY_TYPE_MISMATCH")], []);
    expect(reversed?.code).toBe("EXIT_TRAIL_NOT_ARMED");
  });

  // The stage-error bucket used to be excluded wholesale, which hid a deterministic
  // broker rejection (a stop repair submitted on top of the resting stop it replaces)
  // for as long as it existed. Only the transient half stays excluded.
  it("routes a deterministic stage error to the agent, but not a transient one", () => {
    expect(pickFinding([f("fail", "BROKER_ORDER_REJECTED")], [])?.code).toBe("BROKER_ORDER_REJECTED");
    expect(pickFinding([f("warn", "QUOTE_SYMBOL_INVALID")], [])?.code).toBe("QUOTE_SYMBOL_INVALID");
    expect(pickFinding([f("warn", "BROKER_API_ERROR")], [])).toBeNull();
    expect(pickFinding([f("warn", "STAGE_ERROR")], [])).toBeNull();
  });

  it("does not mutate the input array", () => {
    const findings = [f("warn", "B_WARN"), f("fail", "A_FAIL")];
    const before = findings.map((x) => x.code);
    pickFinding(findings, []);
    expect(findings.map((x) => x.code)).toEqual(before);
  });
});
