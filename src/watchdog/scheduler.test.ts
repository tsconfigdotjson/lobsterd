import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as resume from "../commands/resume.js";
import * as suspend from "../commands/suspend.js";
import * as exec from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import { makeConfig, makeRegistry, makeTenant } from "../test-helpers.js";
import type {
  LobsterError,
  TenantWatchState,
  WatchdogEvents,
} from "../types/index.js";
import { WatchdogEmitter } from "./events.js";
import type { SchedulerHandle } from "./scheduler.js";
import { startScheduler } from "./scheduler.js";
import { initialWatchState } from "./state.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function waitForEvent<K extends keyof WatchdogEvents>(
  emitter: WatchdogEmitter,
  event: K,
  timeoutMs = 5000,
): Promise<WatchdogEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${event}`)),
      timeoutMs,
    );
    const unsub = emitter.on(event, (data) => {
      clearTimeout(timer);
      unsub();
      resolve(data);
    });
  });
}

function healthyStates(
  ...names: string[]
): () => Record<string, TenantWatchState> {
  return () => {
    const states: Record<string, TenantWatchState> = {};
    for (const name of names) {
      states[name] = { ...initialWatchState(), state: "HEALTHY" };
    }
    return states;
  };
}

function schedulerConfig(
  overrides?: Partial<ReturnType<typeof makeConfig>["watchdog"]>,
) {
  return makeConfig({
    watchdog: {
      ...makeConfig().watchdog,
      trafficPollMs: 50,
      idleThresholdMs: 0,
      ...overrides,
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("startScheduler", () => {
  let schedulerHandle: SchedulerHandle;
  let s: Record<string, ReturnType<typeof spyOn>>;

  beforeEach(() => {
    s = {
      runResume: spyOn(resume, "runResume").mockImplementation(
        (name: string) =>
          okAsync(
            makeTenant({ name, status: "active", vmPid: 99999 }),
          ) as never,
      ),
      runSuspend: spyOn(suspend, "runSuspend").mockImplementation(
        (name: string) =>
          okAsync(
            makeTenant({
              name,
              status: "suspended",
              vmPid: null,
              suspendInfo: null,
            }),
          ) as never,
      ),
      execUnchecked: spyOn(exec, "execUnchecked").mockReturnValue(
        okAsync({ exitCode: 0, stdout: "", stderr: "" }) as never,
      ),
      getActiveConnections: spyOn(
        vsock,
        "getActiveConnections",
      ).mockReturnValue(okAsync({ tcp: 0, cron: 0, hold: 0 }) as never),
      pokeCron: spyOn(vsock, "pokeCron").mockReturnValue(
        okAsync(undefined) as never,
      ),
      bunListen: spyOn(Bun, "listen").mockImplementation(
        () =>
          ({
            stop: () => {},
            hostname: "0.0.0.0",
            port: 9000,
          }) as never,
      ),
    };
  });

  afterEach(() => {
    schedulerHandle?.stop();
    for (const spy of Object.values(s)) {
      spy.mockRestore();
    }
  });

  test("triggers suspend when tenant is idle (0 connections)", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 0, cron: 0, hold: 0 }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    const suspendData = await waitForEvent(emitter, "suspend-start");
    expect(suspendData.tenant).toBe(t.name);

    await waitForEvent(emitter, "suspend-complete");
    expect(s.runSuspend).toHaveBeenCalledWith(t.name);
  });

  test("does not suspend when tenant has active connections", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 1, cron: 0, hold: 0 }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    const events: unknown[] = [];
    emitter.on("suspend-start", (d) => events.push(d));
    await Bun.sleep(200);

    expect(events).toHaveLength(0);
    expect(s.runSuspend).not.toHaveBeenCalled();
  });

  test("emits scheduler-poll with connection info", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    const connInfo = { tcp: 2, cron: 0, hold: 0 };
    s.getActiveConnections.mockReturnValue(okAsync(connInfo) as never);

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    const pollData = await waitForEvent(emitter, "scheduler-poll");
    expect(pollData.tenant).toBe(t.name);
    expect(pollData.connections).toEqual(connInfo);
    expect(pollData.idleFor).toBeNull(); // active connections → no idle
  });

  test("suspend failure reverts status and emits suspend-failed", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.runSuspend.mockImplementation(
      () =>
        errAsync({
          code: "SNAPSHOT_FAILED" as LobsterError["code"],
          message: "snapshot failed",
        }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    const failData = await waitForEvent(emitter, "suspend-failed");
    expect(failData.tenant).toBe(t.name);
    expect(failData.error).toBe("snapshot failed");
    expect(registry.tenants[0].status).toBe("active");
  });

  test("SUSPEND_SKIPPED reverts status and emits suspend-skipped", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.runSuspend.mockImplementation(
      () =>
        errAsync({
          code: "SUSPEND_SKIPPED" as LobsterError["code"],
          message: "cron wake too close",
        }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    const skipData = await waitForEvent(emitter, "suspend-skipped");
    expect(skipData.tenant).toBe(t.name);
    expect(skipData.reason).toBe("cron wake too close");
    expect(registry.tenants[0].status).toBe("active");
  });

  test("skips tenants with unhealthy watch state (DEGRADED)", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 0, cron: 0, hold: 0 }) as never,
    );

    const degradedStates = () => ({
      [t.name]: { ...initialWatchState(), state: "DEGRADED" as const },
    });

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      degradedStates,
      inFlight,
    );

    const events: unknown[] = [];
    emitter.on("suspend-start", (d) => events.push(d));
    await Bun.sleep(200);

    expect(events).toHaveLength(0);
  });

  test("skips tenants with FAILED watch state", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 0, cron: 0, hold: 0 }) as never,
    );

    const failedStates = () => ({
      [t.name]: { ...initialWatchState(), state: "FAILED" as const },
    });

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      failedStates,
      inFlight,
    );

    const events: unknown[] = [];
    emitter.on("suspend-start", (d) => events.push(d));
    await Bun.sleep(200);

    expect(events).toHaveLength(0);
  });

  test("scheduleWake triggers resume when wake time is past", async () => {
    const t = makeTenant({
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00Z",
        snapshotDir: "/snapshots/test",
        cronSchedules: [],
        nextWakeAtMs: Date.now() - 1000, // Already past
        wakeReason: "cron",
        lastRxBytes: 0,
      },
    });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      inFlight,
    );

    const resumeData = await waitForEvent(emitter, "resume-start");
    expect(resumeData.tenant).toBe(t.name);
    expect(resumeData.trigger).toBe("cron");

    await waitForEvent(emitter, "resume-complete");
    expect(s.runResume).toHaveBeenCalledWith(t.name);
  });

  test("scheduleWake with heartbeat reason uses heartbeat trigger", async () => {
    const t = makeTenant({
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00Z",
        snapshotDir: "/snapshots/test",
        cronSchedules: [],
        nextWakeAtMs: Date.now() - 1000,
        wakeReason: "heartbeat",
        lastRxBytes: 0,
      },
    });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      inFlight,
    );

    const resumeData = await waitForEvent(emitter, "resume-start");
    expect(resumeData.trigger).toBe("heartbeat");
  });

  test("resume failure emits resume-failed", async () => {
    const t = makeTenant({
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00Z",
        snapshotDir: "/snapshots/test",
        cronSchedules: [],
        nextWakeAtMs: Date.now() - 1000,
        wakeReason: "cron",
        lastRxBytes: 0,
      },
    });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.runResume.mockImplementation(
      () =>
        errAsync({
          code: "RESUME_FAILED" as LobsterError["code"],
          message: "vm gone",
        }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      inFlight,
    );

    const failData = await waitForEvent(emitter, "resume-failed");
    expect(failData.tenant).toBe(t.name);
    expect(failData.error).toBe("vm gone");
  });

  test("cleans up stale IPs on startup", async () => {
    const t = makeTenant({ ipAddress: "10.0.0.6" });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      healthyStates(t.name),
      new Set(),
    );

    // Give the IIFE time to run
    await Bun.sleep(50);

    expect(s.execUnchecked).toHaveBeenCalledWith([
      "ip",
      "addr",
      "del",
      "10.0.0.6/32",
      "dev",
      "lo",
    ]);
  });

  test("starts sentinel for suspended tenants on startup", async () => {
    const t = makeTenant({
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00Z",
        snapshotDir: "/snapshots/test",
        cronSchedules: [],
        nextWakeAtMs: Date.now() + 999_999, // Far future
        wakeReason: "cron",
        lastRxBytes: 0,
      },
    });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      new Set(),
    );

    // Give the IIFE time to run
    await Bun.sleep(50);

    // Should have called Bun.listen for the sentinel
    expect(s.bunListen).toHaveBeenCalled();
    // Should have added IP for sentinel
    expect(s.execUnchecked).toHaveBeenCalledWith([
      "ip",
      "addr",
      "add",
      `${t.ipAddress}/32`,
      "dev",
      "lo",
    ]);
  });

  test("stop() prevents further events", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    // Start with active connections so no suspend
    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 1, cron: 0, hold: 0 }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    // Wait for at least one poll
    await waitForEvent(emitter, "scheduler-poll");
    schedulerHandle.stop();

    // Now switch to idle — should NOT trigger suspend
    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 0, cron: 0, hold: 0 }) as never,
    );

    const events: unknown[] = [];
    emitter.on("suspend-start", (d) => events.push(d));
    await Bun.sleep(200);

    expect(events).toHaveLength(0);
  });

  test("skips suspended tenants in idle detection", async () => {
    const t = makeTenant({ status: "suspended", vmPid: null });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      new Set(),
    );

    await Bun.sleep(200);

    // getActiveConnections should not be called for suspended tenants
    expect(s.getActiveConnections).not.toHaveBeenCalled();
  });

  test("skips non-active tenants in idle detection", async () => {
    const t = makeTenant({ status: "removing" });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      new Set(),
    );

    await Bun.sleep(200);

    expect(s.getActiveConnections).not.toHaveBeenCalled();
    expect(s.runSuspend).not.toHaveBeenCalled();
  });

  test("in-flight guard prevents concurrent suspend", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>([t.name]);

    s.getActiveConnections.mockReturnValue(
      okAsync({ tcp: 0, cron: 0, hold: 0 }) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig(),
      registry,
      emitter,
      healthyStates(t.name),
      inFlight,
    );

    await Bun.sleep(200);

    expect(s.runSuspend).not.toHaveBeenCalled();
  });

  test("resume success syncs tenant state from result", async () => {
    const t = makeTenant({
      name: "my-vm",
      status: "suspended",
      vmPid: null,
      suspendInfo: {
        suspendedAt: "2025-01-01T00:00:00Z",
        snapshotDir: "/snapshots/test",
        cronSchedules: [],
        nextWakeAtMs: Date.now() - 1000,
        wakeReason: "cron",
        lastRxBytes: 0,
      },
    });
    const registry = makeRegistry([t]);
    const emitter = new WatchdogEmitter();
    const inFlight = new Set<string>();

    s.runResume.mockImplementation(
      () =>
        okAsync(
          makeTenant({ name: "my-vm", status: "active", vmPid: 54321 }),
        ) as never,
    );

    schedulerHandle = startScheduler(
      schedulerConfig({ trafficPollMs: 999_999 }),
      registry,
      emitter,
      () => ({
        [t.name]: { ...initialWatchState(), state: "SUSPENDED" },
      }),
      inFlight,
    );

    const completeData = await waitForEvent(emitter, "resume-complete");
    expect(completeData.vmPid).toBe(54321);

    // Registry should be synced with the resume result
    expect(registry.tenants[0].status).toBe("active");
    expect(registry.tenants[0].vmPid).toBe(54321);
  });
});
