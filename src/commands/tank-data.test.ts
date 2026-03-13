import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as checks from "../checks/index.js";
import * as vsock from "../system/vsock.js";
import { makeConfig, makeTenant } from "../test-helpers.js";
import type { GuestStats, LobsterError } from "../types/index.js";
import { buildTankEntries, quickPidCheck } from "./tank-data.js";

describe("quickPidCheck", () => {
  afterEach(() => {
    // Restore all mocks after each test
  });

  test("null vmPid returns dead", () => {
    const tenant = makeTenant({ vmPid: null });
    expect(quickPidCheck(tenant)).toBe("dead");
  });

  test("process.kill succeeds returns pid string", () => {
    const spy = spyOn(process, "kill").mockImplementation(() => true);
    const tenant = makeTenant({ vmPid: 42 });
    expect(quickPidCheck(tenant)).toBe("42");
    expect(spy).toHaveBeenCalledWith(42, 0);
    spy.mockRestore();
  });

  test("process.kill throws returns dead", () => {
    const spy = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const tenant = makeTenant({ vmPid: 99999 });
    expect(quickPidCheck(tenant)).toBe("dead");
    spy.mockRestore();
  });
});

const allOkChecks = [
  { check: "vm.process", status: "ok" as const, message: "" },
  { check: "vm.responsive", status: "ok" as const, message: "" },
  { check: "net.tap-exists", status: "ok" as const, message: "" },
  { check: "net.gateway-running", status: "ok" as const, message: "" },
  { check: "net.caddy-route", status: "ok" as const, message: "" },
];

describe("buildTankEntries", () => {
  let killSpy: ReturnType<typeof spyOn>;
  let statsSpy: ReturnType<typeof spyOn>;
  let checksSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    killSpy?.mockRestore();
    statsSpy?.mockRestore();
    checksSpy?.mockRestore();
  });

  test("suspended tenant returns SUSPENDED state", async () => {
    const tenant = makeTenant({ status: "suspended", vmPid: null });
    const config = makeConfig();

    statsSpy = spyOn(vsock, "getStats");
    checksSpy = spyOn(checks, "runAllChecks");

    const entries = await buildTankEntries([tenant], config);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(tenant.name);
    expect(entries[0].cid).toBe(tenant.cid);
    expect(entries[0].ip).toBe(tenant.ipAddress);
    expect(entries[0].port).toBe(tenant.gatewayPort);
    expect(entries[0].vmPid).toBe("suspended");
    expect(entries[0].status).toBe("suspended");
    expect(entries[0].memoryMb).toBeUndefined();
    expect(entries[0].state).toBe("SUSPENDED");

    expect(statsSpy).not.toHaveBeenCalled();
    expect(checksSpy).not.toHaveBeenCalled();
  });

  test("active tenant with dead process skips getStats", async () => {
    const tenant = makeTenant({ vmPid: 42, status: "active" });
    const config = makeConfig();

    killSpy = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    statsSpy = spyOn(vsock, "getStats");
    checksSpy = spyOn(checks, "runAllChecks").mockReturnValue(
      okAsync(allOkChecks),
    );

    const entries = await buildTankEntries([tenant], config);

    expect(entries).toHaveLength(1);
    expect(entries[0].vmPid).toBe("dead");
    expect(entries[0].memoryMb).toBeUndefined();
    // UNKNOWN -> all ok -> HEALTHY
    expect(entries[0].state).toBe("HEALTHY");

    expect(statsSpy).not.toHaveBeenCalled();
    expect(checksSpy).toHaveBeenCalledWith(tenant, config);
  });

  test("active tenant with live process and stats", async () => {
    const tenant = makeTenant({ vmPid: 42, status: "active" });
    const config = makeConfig();

    killSpy = spyOn(process, "kill").mockImplementation(() => true);
    statsSpy = spyOn(vsock, "getStats").mockReturnValue(
      okAsync({
        gatewayPid: 100,
        memoryKb: 262144,
        activeConnections: 3,
      } satisfies GuestStats),
    );
    checksSpy = spyOn(checks, "runAllChecks").mockReturnValue(
      okAsync(allOkChecks),
    );

    const entries = await buildTankEntries([tenant], config);

    expect(entries).toHaveLength(1);
    expect(entries[0].vmPid).toBe("42");
    expect(entries[0].memoryMb).toBe(256);
    expect(entries[0].state).toBe("HEALTHY");

    expect(statsSpy).toHaveBeenCalledWith(
      tenant.ipAddress,
      config.vsock.agentPort,
      tenant.agentToken,
    );
  });

  test("active tenant with checks error returns UNKNOWN state", async () => {
    const tenant = makeTenant({ vmPid: 42, status: "active" });
    const config = makeConfig();

    killSpy = spyOn(process, "kill").mockImplementation(() => true);
    statsSpy = spyOn(vsock, "getStats").mockReturnValue(
      okAsync({
        gatewayPid: 100,
        memoryKb: 512000,
        activeConnections: 0,
      } satisfies GuestStats),
    );
    checksSpy = spyOn(checks, "runAllChecks").mockReturnValue(
      errAsync({
        code: "VSOCK_CONNECT_FAILED",
        message: "could not connect",
      } satisfies LobsterError),
    );

    const entries = await buildTankEntries([tenant], config);

    expect(entries).toHaveLength(1);
    expect(entries[0].vmPid).toBe("42");
    expect(entries[0].memoryMb).toBe(500);
    expect(entries[0].state).toBe("UNKNOWN");
  });
});
