import { describe, expect, test } from "bun:test";
import { makeConfig } from "../test-helpers.js";
import type { HealthCheckResult, TenantWatchState } from "../types/index.js";
import { initialWatchState, resetToMolting, transition } from "./state.js";

const config = makeConfig().watchdog;

const okResult: HealthCheckResult = {
  check: "vm-running",
  status: "ok",
  message: "ok",
};
const failResult: HealthCheckResult = {
  check: "vm-running",
  status: "failed",
  message: "down",
};

function stateWith(overrides: Partial<TenantWatchState>): TenantWatchState {
  return { ...initialWatchState(), ...overrides };
}

// ── initialWatchState ───────────────────────────────────────────────────────

describe("initialWatchState", () => {
  test("returns UNKNOWN with zeroed fields", () => {
    const s = initialWatchState();
    expect(s.state).toBe("UNKNOWN");
    expect(s.lastCheck).toBeNull();
    expect(s.lastResults).toEqual([]);
    expect(s.repairAttempts).toBe(0);
    expect(s.lastRepairAt).toBeNull();
  });
});

// ── transition ──────────────────────────────────────────────────────────────

describe("transition", () => {
  test("UNKNOWN + all ok -> HEALTHY", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "UNKNOWN" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("HEALTHY");
    expect(needsRepair).toBe(false);
  });

  test("UNKNOWN + fail -> DEGRADED", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "UNKNOWN" }),
      [failResult],
      config,
    );
    expect(next.state).toBe("DEGRADED");
    expect(needsRepair).toBe(true);
  });

  test("HEALTHY + ok -> HEALTHY", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "HEALTHY" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("HEALTHY");
    expect(needsRepair).toBe(false);
  });

  test("HEALTHY + fail -> DEGRADED", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "HEALTHY" }),
      [failResult],
      config,
    );
    expect(next.state).toBe("DEGRADED");
    expect(needsRepair).toBe(true);
  });

  test("DEGRADED + ok -> RECOVERING", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "DEGRADED" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("RECOVERING");
    expect(needsRepair).toBe(false);
  });

  test("DEGRADED + fail + attempts < max -> DEGRADED (repair)", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "DEGRADED", repairAttempts: 1 }),
      [failResult],
      config,
    );
    expect(next.state).toBe("DEGRADED");
    expect(needsRepair).toBe(true);
  });

  test("DEGRADED + fail + attempts >= max -> FAILED", () => {
    const { next, needsRepair } = transition(
      stateWith({
        state: "DEGRADED",
        repairAttempts: config.maxRepairAttempts,
      }),
      [failResult],
      config,
    );
    expect(next.state).toBe("FAILED");
    expect(needsRepair).toBe(false);
  });

  test("RECOVERING + ok -> HEALTHY", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "RECOVERING" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("HEALTHY");
    expect(needsRepair).toBe(false);
  });

  test("RECOVERING + fail -> DEGRADED", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "RECOVERING" }),
      [failResult],
      config,
    );
    expect(next.state).toBe("DEGRADED");
    expect(needsRepair).toBe(true);
  });

  test("FAILED + ok -> HEALTHY", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "FAILED" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("HEALTHY");
    expect(needsRepair).toBe(false);
  });

  test("FAILED + fail -> FAILED (no repair)", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "FAILED" }),
      [failResult],
      config,
    );
    expect(next.state).toBe("FAILED");
    expect(needsRepair).toBe(false);
  });

  test("SUSPENDED + ok -> HEALTHY", () => {
    const { next, needsRepair } = transition(
      stateWith({ state: "SUSPENDED" }),
      [okResult],
      config,
    );
    expect(next.state).toBe("HEALTHY");
    expect(needsRepair).toBe(false);
  });
});

// ── resetToMolting ──────────────────────────────────────────────────────────

describe("resetToMolting", () => {
  test("resets state to DEGRADED with zero attempts", () => {
    const current = stateWith({
      state: "FAILED",
      repairAttempts: 5,
      lastRepairAt: "2025-01-01T00:00:00Z",
    });
    const result = resetToMolting(current);
    expect(result.state).toBe("DEGRADED");
    expect(result.repairAttempts).toBe(0);
    expect(result.lastRepairAt).toBeNull();
  });

  test("preserves lastCheck and lastResults", () => {
    const current = stateWith({
      state: "FAILED",
      lastCheck: "2025-01-01T00:00:00Z",
      lastResults: [okResult],
    });
    const result = resetToMolting(current);
    expect(result.lastCheck).toBe("2025-01-01T00:00:00Z");
    expect(result.lastResults).toEqual([okResult]);
  });
});
