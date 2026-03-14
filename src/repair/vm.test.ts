import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as exec from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import {
  makeConfig,
  makeRegistry,
  makeTenant,
  unwrapOk,
} from "../test-helpers.js";
import type { ExecResult, LobsterError } from "../types/index.js";

// Cache-busting import to bypass mock.module("./vm.js") in index.test.ts
import type {
  repairVmProcess as VmProcessFn,
  repairVmResponsive as VmResponsiveFn,
} from "./vm.js";

const mod = await import(
  // @ts-expect-error — Bun supports query-string imports for cache busting
  "./vm.js?direct"
);
const repairVmProcess = mod.repairVmProcess as typeof VmProcessFn;
const repairVmResponsive = mod.repairVmResponsive as typeof VmResponsiveFn;

// ── repairVmProcess ─────────────────────────────────────────────────────────

describe("repairVmProcess", () => {
  let s: Record<string, ReturnType<typeof spyOn>>;

  beforeEach(() => {
    s = {
      kill: spyOn(process, "kill").mockImplementation(() => true),
      bunSpawn: spyOn(Bun, "spawn").mockImplementation(
        () =>
          ({
            pid: 99999,
            unref: () => {},
            exited: Promise.resolve(0),
          }) as never,
      ),
      bunSleep: spyOn(Bun, "sleep").mockResolvedValue(undefined as never),
      execUnchecked: spyOn(exec, "execUnchecked").mockReturnValue(
        okAsync<ExecResult, LobsterError>({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }) as never,
      ),
      cleanupChroot: spyOn(jailer, "cleanupChroot").mockReturnValue(
        okAsync(undefined) as never,
      ),
      buildJailerArgs: spyOn(jailer, "buildJailerArgs").mockReturnValue([
        "jailer",
        "--id",
        "test",
      ] as never),
      linkChrootFiles: spyOn(jailer, "linkChrootFiles").mockReturnValue(
        okAsync(undefined) as never,
      ),
      configureVm: spyOn(fc, "configureVm").mockReturnValue(
        okAsync(undefined) as never,
      ),
      setBootSource: spyOn(fc, "setBootSource").mockReturnValue(
        okAsync(undefined) as never,
      ),
      addDrive: spyOn(fc, "addDrive").mockReturnValue(
        okAsync(undefined) as never,
      ),
      addNetworkInterface: spyOn(fc, "addNetworkInterface").mockReturnValue(
        okAsync(undefined) as never,
      ),
      startInstance: spyOn(fc, "startInstance").mockReturnValue(
        okAsync(undefined) as never,
      ),
      waitForAgent: spyOn(vsock, "waitForAgent").mockReturnValue(
        okAsync(undefined) as never,
      ),
      injectSecrets: spyOn(vsock, "injectSecrets").mockReturnValue(
        okAsync(undefined) as never,
      ),
      saveRegistry: spyOn(loader, "saveRegistry").mockReturnValue(
        okAsync(undefined) as never,
      ),
    };
  });

  afterEach(() => {
    for (const spy of Object.values(s)) {
      spy.mockRestore();
    }
  });

  test("happy path repairs VM and returns fixed: true", async () => {
    const tenant = makeTenant({ vmPid: 12345 });
    const config = makeConfig();
    const registry = makeRegistry([tenant]);

    const result = await unwrapOk(repairVmProcess(tenant, config, registry));

    expect(result.repair).toBe("vm.process");
    expect(result.fixed).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);

    expect(s.cleanupChroot).toHaveBeenCalledTimes(1);
    expect(s.linkChrootFiles).toHaveBeenCalledTimes(1);
    expect(s.configureVm).toHaveBeenCalledTimes(1);
    expect(s.setBootSource).toHaveBeenCalledTimes(1);
    expect(s.addDrive).toHaveBeenCalledTimes(2);
    expect(s.addNetworkInterface).toHaveBeenCalledTimes(1);
    expect(s.startInstance).toHaveBeenCalledTimes(1);
    expect(s.waitForAgent).toHaveBeenCalledTimes(1);
    expect(s.injectSecrets).toHaveBeenCalledTimes(1);
    expect(s.saveRegistry).toHaveBeenCalledTimes(1);
  });

  test("returns fixed: false on startInstance failure", async () => {
    s.startInstance.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "VM_BOOT_FAILED",
        message: "mock failure",
      }) as never,
    );

    const tenant = makeTenant({ vmPid: 12345 });
    const config = makeConfig();
    const registry = makeRegistry([tenant]);

    const result = await unwrapOk(repairVmProcess(tenant, config, registry));

    expect(result.repair).toBe("vm.process");
    expect(result.fixed).toBe(false);
    expect(result.actions).toContain("Failed to restart VM");
  });

  test("kills existing vmPid if present", async () => {
    const tenant = makeTenant({ vmPid: 12345 });
    const config = makeConfig();
    const registry = makeRegistry([tenant]);

    await unwrapOk(repairVmProcess(tenant, config, registry));

    expect(s.kill).toHaveBeenCalledWith(12345, "SIGKILL");
  });
});

// ── repairVmResponsive ──────────────────────────────────────────────────────

describe("repairVmResponsive", () => {
  let s: Record<string, ReturnType<typeof spyOn>>;

  beforeEach(() => {
    s = {};
  });

  afterEach(() => {
    for (const spy of Object.values(s)) {
      spy.mockRestore();
    }
  });

  test("returns fixed: true when ensureGateway succeeds", async () => {
    s.ensureGateway = spyOn(vsock, "ensureGateway").mockReturnValue(
      okAsync(undefined) as never,
    );

    const tenant = makeTenant();
    const config = makeConfig();

    const result = await unwrapOk(repairVmResponsive(tenant, config));

    expect(result.repair).toBe("vm.responsive");
    expect(result.fixed).toBe(true);
    expect(result.actions).toContain("Ensured gateway is running");
  });

  test("returns fixed: false when ensureGateway fails", async () => {
    s.ensureGateway = spyOn(vsock, "ensureGateway").mockReturnValue(
      errAsync<void, LobsterError>({
        code: "VSOCK_CONNECT_FAILED",
        message: "mock failure",
      }) as never,
    );

    const tenant = makeTenant();
    const config = makeConfig();

    const result = await unwrapOk(repairVmResponsive(tenant, config));

    expect(result.repair).toBe("vm.responsive");
    expect(result.fixed).toBe(false);
    expect(result.actions).toContain(
      "Failed to ensure gateway — VM may need full restart",
    );
  });
});
