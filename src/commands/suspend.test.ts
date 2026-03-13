import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as exec from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import {
  makeConfig,
  makeRegistry,
  makeTenant,
  unwrapErr,
  unwrapOk,
} from "../test-helpers.js";
import type { ExecResult, LobsterError } from "../types/index.js";
import { runSuspend } from "./suspend.js";

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
    pauseVm: spyOn(fc, "pauseVm").mockReturnValue(okAsync(undefined) as never),
    createSnapshot: spyOn(fc, "createSnapshot").mockReturnValue(
      okAsync(undefined) as never,
    ),
    cleanupChroot: spyOn(jailer, "cleanupChroot").mockReturnValue(
      okAsync(undefined) as never,
    ),
    getChrootRoot: spyOn(jailer, "getChrootRoot").mockReturnValue(
      "/var/lib/lobsterd/jailer/vm-test-tenant/root" as never,
    ),
    getCronSchedules: spyOn(vsock, "getCronSchedules").mockReturnValue(
      okAsync([]) as never,
    ),
    getHeartbeatSchedule: spyOn(vsock, "getHeartbeatSchedule").mockReturnValue(
      okAsync({ enabled: false, intervalMs: 0, nextBeatAtMs: 0 }) as never,
    ),
    readFileSync: spyOn(fs, "readFileSync").mockReturnValue("12345\n" as never),
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

describe("runSuspend", () => {
  test("returns TENANT_NOT_FOUND for unknown tenant", async () => {
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([])) as never);
    const err = await unwrapErr(runSuspend("nonexistent"));
    expect(err.code).toBe("TENANT_NOT_FOUND");
  });

  test("returns SUSPEND_FAILED for non-active tenant", async () => {
    const tenant = makeTenant({ status: "suspended" });
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([tenant])) as never);
    const err = await unwrapErr(runSuspend("test-tenant"));
    expect(err.code).toBe("SUSPEND_FAILED");
  });

  test("returns SUSPEND_SKIPPED when wake is imminent", async () => {
    const now = Date.now();
    // nextRunAtMs is 5s from now, which is within the 15s cronWakeAheadMs window
    s.getCronSchedules.mockReturnValue(
      okAsync([
        {
          id: "cron-1",
          name: "soon-job",
          nextRunAtMs: now + 5_000,
          schedule: null,
        },
      ]) as never,
    );

    const err = await unwrapErr(runSuspend("test-tenant"));
    expect(err.code).toBe("SUSPEND_SKIPPED");
  });

  test("happy path suspends active tenant", async () => {
    const result = await unwrapOk(runSuspend("test-tenant"));

    expect(result.name).toBe("test-tenant");
    expect(result.status).toBe("suspended");
    expect(result.suspendInfo).toBeDefined();
    expect(result.vmPid).toBeNull();

    expect(s.pauseVm).toHaveBeenCalledTimes(1);
    expect(s.createSnapshot).toHaveBeenCalledTimes(1);
    // mkdir + cp snapshot_file + cp mem_file
    expect(s.exec).toHaveBeenCalledTimes(3);
    expect(s.cleanupChroot).toHaveBeenCalledTimes(1);
    expect(s.saveRegistry).toHaveBeenCalledTimes(1);
  });

  test("calls onProgress callbacks", async () => {
    const steps: string[] = [];
    const onProgress = (p: { step: string; detail: string }) => {
      steps.push(p.step);
    };

    await unwrapOk(runSuspend("test-tenant", onProgress));

    expect(steps.length).toBeGreaterThan(0);
    expect(steps).toContain("cron");
    expect(steps).toContain("pause");
    expect(steps).toContain("snapshot");
    expect(steps).toContain("registry");
  });
});
