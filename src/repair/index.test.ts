import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import * as networkSys from "../system/network.js";
import { makeConfig, makeRegistry, makeTenant } from "../test-helpers.js";
import type {
  HealthCheckResult,
  LobsterError,
  RepairResult,
} from "../types/index.js";

// repairVmProcess/repairVmResponsive have heavy deps (jailer, firecracker,
// Bun.spawn) — mock the entire module. No other test file imports repair/vm.js
// so this mock.module won't cause cross-file conflicts.
const repairVmProcessMock = mock(() =>
  okAsync<RepairResult, LobsterError>({
    repair: "vm.process",
    fixed: true,
    actions: ["restarted"],
  }),
);
const repairVmResponsiveMock = mock(() =>
  okAsync<RepairResult, LobsterError>({
    repair: "vm.responsive",
    fixed: true,
    actions: ["ensured gateway"],
  }),
);

mock.module("./vm.js", () => ({
  repairVmProcess: repairVmProcessMock,
  repairVmResponsive: repairVmResponsiveMock,
}));

// Cache-busting query ensures a fresh module evaluation even if another test
// file triggered a cached load of ./index.js with un-mocked deps.
// @ts-expect-error — Bun supports query-string imports for cache busting
const { runRepairs } = await import("./index.js?test");

// For network repairs: spyOn the system-level deps so the real
// repairTap/repairCaddyRoute run but call mocked system functions.
let createTapSpy: ReturnType<typeof spyOn>;
let addNatSpy: ReturnType<typeof spyOn>;
let addIsolationRulesSpy: ReturnType<typeof spyOn>;
let removeRouteSpy: ReturnType<typeof spyOn>;
let addRouteSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  createTapSpy = spyOn(networkSys, "createTap");
  addNatSpy = spyOn(networkSys, "addNat");
  addIsolationRulesSpy = spyOn(networkSys, "addIsolationRules");
  removeRouteSpy = spyOn(caddy, "removeRoute");
  addRouteSpy = spyOn(caddy, "addRoute");
});

function mockNetworkOk() {
  createTapSpy.mockReturnValue(okAsync(undefined) as never);
  addNatSpy.mockReturnValue(okAsync(undefined) as never);
  addIsolationRulesSpy.mockReturnValue(okAsync(undefined) as never);
  removeRouteSpy.mockReturnValue(okAsync(undefined) as never);
  addRouteSpy.mockReturnValue(okAsync(undefined) as never);
}

afterEach(() => {
  repairVmProcessMock.mockClear();
  repairVmResponsiveMock.mockClear();
  createTapSpy.mockRestore();
  addNatSpy.mockRestore();
  addIsolationRulesSpy.mockRestore();
  removeRouteSpy.mockRestore();
  addRouteSpy.mockRestore();
});

const tenant = makeTenant();
const config = makeConfig();
const registry = makeRegistry([tenant]);

function failedCheck(check: string): HealthCheckResult {
  return { check, status: "failed", message: "broken" };
}

describe("runRepairs", () => {
  test("dispatches vm.process to repairVmProcess", async () => {
    const results = (
      await runRepairs(tenant, [failedCheck("vm.process")], config, registry)
    )._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0].repair).toBe("vm.process");
    expect(results[0].fixed).toBe(true);
    expect(repairVmProcessMock).toHaveBeenCalledTimes(1);
  });

  test("dispatches net.tap to repairTap", async () => {
    mockNetworkOk();
    const results = (
      await runRepairs(tenant, [failedCheck("net.tap")], config, registry)
    )._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0].repair).toBe("net.tap");
    expect(results[0].fixed).toBe(true);
  });

  test("dispatches net.caddy-route to repairCaddyRoute", async () => {
    mockNetworkOk();
    const results = (
      await runRepairs(
        tenant,
        [failedCheck("net.caddy-route")],
        config,
        registry,
      )
    )._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0].repair).toBe("net.caddy-route");
    expect(results[0].fixed).toBe(true);
  });

  test("deduplicates repair functions (vm.responsive and net.gateway share repairVmResponsive)", async () => {
    const results = (
      await runRepairs(
        tenant,
        [failedCheck("vm.responsive"), failedCheck("net.gateway")],
        config,
        registry,
      )
    )._unsafeUnwrap();
    // Should only run repairVmResponsive once, not twice
    expect(results).toHaveLength(1);
    expect(repairVmResponsiveMock).toHaveBeenCalledTimes(1);
  });

  test("returns empty array for no failed checks", async () => {
    const results = (
      await runRepairs(tenant, [], config, registry)
    )._unsafeUnwrap();
    expect(results).toEqual([]);
  });

  test("returns fixed:false when repair throws an error", async () => {
    repairVmProcessMock.mockReturnValueOnce(
      errAsync<RepairResult, LobsterError>({
        code: "VM_BOOT_FAILED",
        message: "crash",
      }),
    );
    const results = (
      await runRepairs(tenant, [failedCheck("vm.process")], config, registry)
    )._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0].fixed).toBe(false);
    expect(results[0].actions).toContain("Repair threw an error");
  });

  test("returns empty for unknown check names", async () => {
    const results = (
      await runRepairs(tenant, [failedCheck("unknown.check")], config, registry)
    )._unsafeUnwrap();
    expect(results).toEqual([]);
  });
});
