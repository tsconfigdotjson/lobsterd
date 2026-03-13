import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as exec_ from "../system/exec.js";
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

import { runResume } from "./resume.js";

const suspendedTenant = makeTenant({
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

describe("runResume", () => {
  const s = {} as Record<string, ReturnType<typeof spyOn>>;

  beforeEach(() => {
    s.loadConfig = spyOn(loader, "loadConfig").mockReturnValue(
      okAsync(makeConfig()) as never,
    );
    s.loadRegistry = spyOn(loader, "loadRegistry").mockReturnValue(
      okAsync(makeRegistry([suspendedTenant])) as never,
    );
    s.saveRegistry = spyOn(loader, "saveRegistry").mockReturnValue(
      okAsync(undefined) as never,
    );
    s.exec = spyOn(exec_, "exec").mockReturnValue(
      okAsync<ExecResult, LobsterError>({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }) as never,
    );
    s.cleanupChroot = spyOn(jailer, "cleanupChroot").mockReturnValue(
      okAsync(undefined) as never,
    );
    s.linkChrootFiles = spyOn(jailer, "linkChrootFiles").mockReturnValue(
      okAsync(undefined) as never,
    );
    s.buildJailerArgs = spyOn(jailer, "buildJailerArgs").mockReturnValue([
      "--id",
      "test-tenant",
    ] as never);
    s.getChrootRoot = spyOn(jailer, "getChrootRoot").mockReturnValue(
      "/srv/jailer/firecracker/test-tenant/root" as never,
    );
    s.loadSnapshot = spyOn(fc, "loadSnapshot").mockReturnValue(
      okAsync(undefined) as never,
    );
    s.setGuestTime = spyOn(vsock, "setGuestTime").mockReturnValue(
      okAsync(undefined) as never,
    );
    s.bunSpawn = spyOn(Bun, "spawn").mockReturnValue({
      pid: 99999,
      unref: () => {},
    } as never);
    s.bunSleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    for (const spy of Object.values(s)) {
      spy.mockRestore();
    }
  });

  test("returns TENANT_NOT_FOUND for unknown tenant", async () => {
    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([])) as never);

    const err = await unwrapErr(runResume("nonexistent"));
    expect(err.code).toBe("TENANT_NOT_FOUND");
  });

  test("returns RESUME_FAILED for non-suspended tenant", async () => {
    const activeTenant = makeTenant({ status: "active" });
    s.loadRegistry.mockReturnValue(
      okAsync(makeRegistry([activeTenant])) as never,
    );

    const err = await unwrapErr(runResume(activeTenant.name));
    expect(err.code).toBe("RESUME_FAILED");
  });

  test("returns RESUME_FAILED for suspended tenant without suspendInfo", async () => {
    const noInfoTenant = makeTenant({
      status: "suspended",
      suspendInfo: null,
    });
    s.loadRegistry.mockReturnValue(
      okAsync(makeRegistry([noInfoTenant])) as never,
    );

    const err = await unwrapErr(runResume(noInfoTenant.name));
    expect(err.code).toBe("RESUME_FAILED");
  });

  test("happy path resumes suspended tenant", async () => {
    const tenant = await unwrapOk(runResume(suspendedTenant.name));

    expect(s.cleanupChroot).toHaveBeenCalled();
    expect(s.bunSpawn).toHaveBeenCalled();
    expect(s.linkChrootFiles).toHaveBeenCalled();

    // cp mem + cp snap + chown = at least 3 exec calls before cleanup
    const execCalls = s.exec.mock.calls;
    expect(execCalls.length).toBeGreaterThanOrEqual(3);

    expect(s.loadSnapshot).toHaveBeenCalled();
    expect(s.setGuestTime).toHaveBeenCalled();
    expect(s.saveRegistry).toHaveBeenCalled();

    expect(tenant.status).toBe("active");
    expect(tenant.vmPid).toBe(99999);
  });
});
