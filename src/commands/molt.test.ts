import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as caddy from "../system/caddy.js";
import * as exec from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import {
  makeConfig,
  makeRegistry,
  makeTenant,
  unwrapErr,
  unwrapOk,
} from "../test-helpers.js";
import type { GuestStats, LobsterError } from "../types/index.js";

// Mock hold.js entirely — no other test uses this module, so no leak concern.
// This avoids loading the real hold.js (which does vsock calls, intervals, resume, etc.).
const withHoldMock = mock();

mock.module("./hold.js", () => ({
  withHold: (...args: unknown[]) => withHoldMock(...args),
  HOLD_TTL_MS: 300_000,
  KEEPALIVE_MS: 120_000,
}));

// Dynamic import AFTER hold mock — triggers loading of checks/repair with real deps.
// The real checks/repair code will run, but their system calls hit our spies.
const { runMolt } = await import("./molt.js");

const tenant = makeTenant();
const config = makeConfig();

let s: Record<string, ReturnType<typeof spyOn>>;

beforeEach(() => {
  s = {
    // Config loader (used by molt to find tenants)
    loadRegistry: spyOn(loader, "loadRegistry").mockReturnValue(
      okAsync(makeRegistry([tenant])) as never,
    ),
    // VM checks: process.kill(vmPid, 0) → alive
    kill: spyOn(process, "kill").mockImplementation(() => true),
    // VM checks: agent health ping → ok
    healthPing: spyOn(vsock, "healthPing").mockReturnValue(
      okAsync(true) as never,
    ),
    // Network checks: agent stats → gateway running
    getStats: spyOn(vsock, "getStats").mockReturnValue(
      okAsync<GuestStats, LobsterError>({
        gatewayPid: 1,
        memoryKb: 1024,
        activeConnections: 0,
      }) as never,
    ),
    // Network checks: TAP device → exists
    execUnchecked: spyOn(exec, "execUnchecked").mockReturnValue(
      okAsync({ exitCode: 0, stdout: "", stderr: "" }) as never,
    ),
    // Network checks: Caddy routes → present (default happy path)
    listRoutes: spyOn(caddy, "listRoutes").mockReturnValue(
      okAsync([
        { "@id": "lobster-test-tenant" },
        { "@id": "lobster-test-tenant-ws" },
      ]) as never,
    ),
    // Repair deps (caddy route repair)
    removeRoute: spyOn(caddy, "removeRoute").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addRoute: spyOn(caddy, "addRoute").mockReturnValue(
      okAsync(undefined) as never,
    ),
  };

  withHoldMock.mockReturnValue(
    okAsync({
      tenant,
      config,
      holdId: "test-hold-id",
      keepalive: () => okAsync(undefined),
      release: () => Promise.resolve(),
    }),
  );
});

afterEach(() => {
  for (const spy of Object.values(s)) {
    spy.mockRestore();
  }
  withHoldMock.mockReset();
});

// Clean up mock.module registrations so they don't leak into other test files
afterAll(() => {
  mock.restore();
});

describe("runMolt", () => {
  test("returns TENANT_NOT_FOUND for unknown tenant name", async () => {
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([])) as never);
    const err = await unwrapErr(runMolt("nonexistent"));
    expect(err.code).toBe("TENANT_NOT_FOUND");
  });

  test("all-healthy fast path skips repairs", async () => {
    const results = await unwrapOk(runMolt("test-tenant"));
    expect(results).toHaveLength(1);
    expect(results[0].healthy).toBe(true);
    expect(results[0].repairs).toEqual([]);
    // No repair actions taken
    expect(s.removeRoute).not.toHaveBeenCalled();
    expect(s.addRoute).not.toHaveBeenCalled();
  });

  test("repair + recheck flow for degraded tenant", async () => {
    // First runAllChecks: caddy routes missing → net.caddy-route fails
    s.listRoutes
      .mockReturnValueOnce(okAsync([]) as never)
      // Second runAllChecks (after repair): routes restored
      .mockReturnValueOnce(
        okAsync([
          { "@id": "lobster-test-tenant" },
          { "@id": "lobster-test-tenant-ws" },
        ]) as never,
      );

    const results = await unwrapOk(runMolt("test-tenant"));
    expect(results).toHaveLength(1);
    expect(results[0].healthy).toBe(true);
    expect(results[0].repairs).toHaveLength(1);
    expect(results[0].repairs[0].repair).toBe("net.caddy-route");
    expect(results[0].repairs[0].fixed).toBe(true);
    // Initial checks had 1 failure, final checks all ok
    expect(
      results[0].initialChecks.filter((c) => c.status !== "ok"),
    ).toHaveLength(1);
    expect(results[0].finalChecks.every((c) => c.status === "ok")).toBe(true);
    // Repair called caddy remove + add
    expect(s.removeRoute).toHaveBeenCalledTimes(1);
    expect(s.addRoute).toHaveBeenCalledTimes(1);
  });
});
