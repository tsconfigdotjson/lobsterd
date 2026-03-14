import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as caddy from "../system/caddy.js";
import * as exec from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as image from "../system/image.js";
import * as jailer from "../system/jailer.js";
import * as network from "../system/network.js";
import * as ssh from "../system/ssh.js";
import {
  makeConfig,
  makeRegistry,
  makeTenant,
  unwrapErr,
  unwrapOk,
} from "../test-helpers.js";
import type { ExecResult, LobsterError } from "../types/index.js";
import { runEvict } from "./evict.js";

let s: Record<string, ReturnType<typeof spyOn>>;

beforeEach(() => {
  const config = makeConfig();
  const tenant = makeTenant();
  const registry = makeRegistry([tenant]);

  s = {
    loadConfig: spyOn(loader, "loadConfig").mockReturnValue(
      okAsync(config) as never,
    ),
    loadRegistry: spyOn(loader, "loadRegistry").mockReturnValue(
      okAsync(registry) as never,
    ),
    saveRegistry: spyOn(loader, "saveRegistry").mockReturnValue(
      okAsync(undefined) as never,
    ),
    exec: spyOn(exec, "exec").mockReturnValue(
      okAsync<ExecResult, LobsterError>({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }) as never,
    ),
    removeRoute: spyOn(caddy, "removeRoute").mockReturnValue(
      okAsync(undefined) as never,
    ),
    sendCtrlAltDel: spyOn(fc, "sendCtrlAltDel").mockReturnValue(
      okAsync(undefined) as never,
    ),
    deleteOverlay: spyOn(image, "deleteOverlay").mockReturnValue(
      okAsync(undefined) as never,
    ),
    cleanupChroot: spyOn(jailer, "cleanupChroot").mockReturnValue(
      okAsync(undefined) as never,
    ),
    removeIsolationRules: spyOn(
      network,
      "removeIsolationRules",
    ).mockReturnValue(okAsync(undefined) as never),
    removeAgentLockdownRules: spyOn(
      network,
      "removeAgentLockdownRules",
    ).mockReturnValue(okAsync(undefined) as never),
    removeNat: spyOn(network, "removeNat").mockReturnValue(
      okAsync(undefined) as never,
    ),
    deleteTap: spyOn(network, "deleteTap").mockReturnValue(
      okAsync(undefined) as never,
    ),
    removeKeypair: spyOn(ssh, "removeKeypair").mockReturnValue(
      okAsync(undefined) as never,
    ),
    // process.kill throws → simulates dead VM, exits shutdown loop immediately
    kill: spyOn(process, "kill").mockImplementation(() => {
      throw new Error("No such process");
    }),
    bunSleep: spyOn(Bun, "sleep").mockResolvedValue(undefined as never),
  };
});

afterEach(() => {
  for (const spy of Object.values(s)) {
    spy.mockRestore();
  }
});

describe("runEvict", () => {
  test("returns TENANT_NOT_FOUND for unknown tenant", async () => {
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([])) as never);
    const err = await unwrapErr(runEvict("nonexistent"));
    expect(err.code).toBe("TENANT_NOT_FOUND");
  });

  test("full cleanup sequence for active tenant", async () => {
    await unwrapOk(runEvict("test-tenant"));

    // saveRegistry called twice: set "removing" + final removal
    expect(s.saveRegistry).toHaveBeenCalledTimes(2);
    expect(s.removeRoute).toHaveBeenCalledTimes(1);
    expect(s.sendCtrlAltDel).toHaveBeenCalledTimes(1);
    expect(s.removeIsolationRules).toHaveBeenCalledTimes(1);
    expect(s.removeNat).toHaveBeenCalledTimes(1);
    expect(s.deleteTap).toHaveBeenCalledTimes(1);
    expect(s.cleanupChroot).toHaveBeenCalledTimes(1);
    expect(s.deleteOverlay).toHaveBeenCalledTimes(1);
    expect(s.removeKeypair).toHaveBeenCalledTimes(1);
  });

  test("cleans up snapshot files for suspended tenant", async () => {
    const suspended = makeTenant({
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00.000Z",
        snapshotDir: "/var/lib/lobsterd/snapshots/test-tenant",
        cronSchedules: [],
        nextWakeAtMs: null,
        wakeReason: null,
        lastRxBytes: 0,
        heartbeatSchedule: null,
      },
    });
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([suspended])) as never);

    await unwrapOk(runEvict("test-tenant"));

    // exec called to rm -rf snapshot dir
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect((s.exec.mock.calls[0] as unknown[])[0]).toEqual([
      "rm",
      "-rf",
      "/var/lib/lobsterd/snapshots/test-tenant",
    ]);
    // No VM shutdown (vmPid is null)
    expect(s.sendCtrlAltDel).not.toHaveBeenCalled();
  });
});
