import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as checks from "../checks/index.js";
import * as loader from "../config/loader.js";
import * as repair from "../repair/index.js";
import { makeConfig, makeRegistry, makeTenant } from "../test-helpers.js";
import type {
  HealthCheckResult,
  LobsterError,
  WatchdogEvents,
} from "../types/index.js";
import type { WatchdogEmitter } from "./events.js";
import type { WatchdogHandle } from "./loop.js";
import { startWatchdog } from "./loop.js";

// ── Check fixtures ──────────────────────────────────────────────────────────

const okCheck: HealthCheckResult = {
  check: "vm-running",
  status: "ok",
  message: "ok",
};
const failCheck: HealthCheckResult = {
  check: "vm-running",
  status: "failed",
  message: "not running",
};

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

function collectEvents<K extends keyof WatchdogEvents>(
  emitter: WatchdogEmitter,
  event: K,
): WatchdogEvents[K][] {
  const collected: WatchdogEvents[K][] = [];
  emitter.on(event, (data) => collected.push(data));
  return collected;
}

/** Config with huge interval so only the initial tick() fires */
function singleTickConfig(
  overrides?: Partial<ReturnType<typeof makeConfig>["watchdog"]>,
) {
  return makeConfig({
    watchdog: { ...makeConfig().watchdog, intervalMs: 999_999, ...overrides },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("startWatchdog", () => {
  let handle: WatchdogHandle;
  let s: Record<string, ReturnType<typeof spyOn>>;

  beforeEach(() => {
    s = {
      loadRegistry: spyOn(loader, "loadRegistry").mockReturnValue(
        okAsync(makeRegistry([])) as never,
      ),
      runAllChecks: spyOn(checks, "runAllChecks").mockReturnValue(
        okAsync([okCheck]) as never,
      ),
      runRepairs: spyOn(repair, "runRepairs").mockReturnValue(
        okAsync([]) as never,
      ),
    };
  });

  afterEach(() => {
    handle?.stop();
    for (const spy of Object.values(s)) {
      spy.mockRestore();
    }
  });

  test("initializes tenant states from registry", () => {
    const registry = makeRegistry([
      makeTenant({ name: "a" }),
      makeTenant({ name: "b" }),
    ]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());

    const states = handle.states();
    expect(Object.keys(states).sort()).toEqual(["a", "b"]);
    expect(states.a.state).toBe("UNKNOWN");
    expect(states.b.state).toBe("UNKNOWN");
  });

  test("transitions UNKNOWN → HEALTHY when all checks pass", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    expect(handle.states()[t.name].state).toBe("HEALTHY");
  });

  test("transitions UNKNOWN → DEGRADED and triggers repair", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([failCheck]) as never);
    s.runRepairs.mockReturnValue(
      okAsync([
        { repair: "vm.process", fixed: true, actions: ["restarted"] },
      ]) as never,
    );

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const repairStarts = collectEvents(handle.emitter, "repair-start");
    const repairCompletes = collectEvents(handle.emitter, "repair-complete");
    await waitForEvent(handle.emitter, "tick-complete");

    expect(handle.states()[t.name].state).toBe("DEGRADED");
    expect(repairStarts).toHaveLength(1);
    expect(repairStarts[0].tenant).toBe(t.name);
    expect(repairCompletes).toHaveLength(1);
    expect(s.runRepairs).toHaveBeenCalledTimes(1);
  });

  test("skips tenants with status 'removing'", async () => {
    const t = makeTenant({ status: "removing" });
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    expect(s.runAllChecks).not.toHaveBeenCalled();
  });

  test("skips in-flight tenants", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    const inFlight = new Set([t.name]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);

    handle = startWatchdog(singleTickConfig(), registry, inFlight);
    await waitForEvent(handle.emitter, "tick-complete");

    expect(s.runAllChecks).not.toHaveBeenCalled();
  });

  test("suspended tenant transitions to SUSPENDED state", async () => {
    const t = makeTenant({ status: "suspended" });
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const stateChanges = collectEvents(handle.emitter, "state-change");
    await waitForEvent(handle.emitter, "tick-complete");

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({
      tenant: t.name,
      from: "UNKNOWN",
      to: "SUSPENDED",
    });
    expect(handle.states()[t.name].state).toBe("SUSPENDED");
  });

  test("does not emit duplicate SUSPENDED state-change", async () => {
    const t = makeTenant({ status: "suspended" });
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);

    const config = makeConfig({
      watchdog: { ...makeConfig().watchdog, intervalMs: 50 },
    });

    handle = startWatchdog(config, registry, new Set());
    const stateChanges = collectEvents(handle.emitter, "state-change");

    await waitForEvent(handle.emitter, "tick-complete");
    await waitForEvent(handle.emitter, "tick-complete");

    expect(stateChanges).toHaveLength(1);
  });

  test("emits state-change event on transition", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const stateChanges = collectEvents(handle.emitter, "state-change");
    await waitForEvent(handle.emitter, "tick-complete");

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({
      tenant: t.name,
      from: "UNKNOWN",
      to: "HEALTHY",
    });
  });

  test("emits check-complete with results", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const checkCompletes = collectEvents(handle.emitter, "check-complete");
    await waitForEvent(handle.emitter, "tick-complete");

    expect(checkCompletes).toHaveLength(1);
    expect(checkCompletes[0].tenant).toBe(t.name);
    expect(checkCompletes[0].results).toEqual([okCheck]);
  });

  test("emits tick-complete with states snapshot", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const tickData = await waitForEvent(handle.emitter, "tick-complete");

    expect(tickData.timestamp).toBeDefined();
    expect(tickData.states[t.name].state).toBe("HEALTHY");
  });

  test("respects repair cooldown on subsequent ticks", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([failCheck]) as never);
    s.runRepairs.mockReturnValue(okAsync([]) as never);

    const config = makeConfig({
      watchdog: {
        ...makeConfig().watchdog,
        intervalMs: 50,
        repairCooldownMs: 999_999,
      },
    });

    handle = startWatchdog(config, registry, new Set());

    // First tick: checks run and repair triggers
    await waitForEvent(handle.emitter, "tick-complete");
    expect(s.runAllChecks).toHaveBeenCalledTimes(1);
    expect(s.runRepairs).toHaveBeenCalledTimes(1);

    // Second tick: tenant skipped due to cooldown
    await waitForEvent(handle.emitter, "tick-complete");
    expect(s.runAllChecks).toHaveBeenCalledTimes(1);
    expect(s.runRepairs).toHaveBeenCalledTimes(1);
  });

  test("picks up newly spawned tenants from disk registry", async () => {
    const existing = makeTenant({ name: "existing" });
    const registry = makeRegistry([existing]);
    const newTenant = makeTenant({ name: "new-one" });

    s.loadRegistry.mockReturnValue(
      okAsync(makeRegistry([existing, newTenant])) as never,
    );
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    const states = handle.states();
    expect(states["new-one"]).toBeDefined();
    expect(states["new-one"].state).toBe("HEALTHY");
    expect(registry.tenants).toHaveLength(2);
  });

  test("removes evicted tenants from disk registry", async () => {
    const t1 = makeTenant({ name: "keep" });
    const t2 = makeTenant({ name: "evicted" });
    const registry = makeRegistry([t1, t2]);

    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([t1])) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    expect(handle.states().evicted).toBeUndefined();
    expect(registry.tenants).toHaveLength(1);
    expect(registry.tenants[0].name).toBe("keep");
  });

  test("pre-repair disk check skips repair when tenant not active", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);

    // First loadRegistry: normal sync
    // Second loadRegistry (pre-repair): tenant now suspended on disk
    s.loadRegistry
      .mockReturnValueOnce(okAsync(registry) as never)
      .mockReturnValueOnce(
        okAsync(makeRegistry([makeTenant({ status: "suspended" })])) as never,
      );
    s.runAllChecks.mockReturnValue(okAsync([failCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    expect(s.runRepairs).not.toHaveBeenCalled();
  });

  test("continues processing when loadRegistry fails", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);

    s.loadRegistry.mockReturnValue(
      errAsync({
        code: "UNKNOWN",
        message: "disk error",
      } as LobsterError) as never,
    );
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    const tickData = await waitForEvent(handle.emitter, "tick-complete");

    // Tick completes with existing registry tenants
    expect(tickData.states[t.name].state).toBe("HEALTHY");
    expect(s.runAllChecks).toHaveBeenCalledTimes(1);
  });

  test("stop() prevents further event emissions", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([okCheck]) as never);

    const config = makeConfig({
      watchdog: { ...makeConfig().watchdog, intervalMs: 50 },
    });

    handle = startWatchdog(config, registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");
    handle.stop();

    const events: unknown[] = [];
    handle.emitter.on("tick-complete", (d) => events.push(d));
    await Bun.sleep(150);

    expect(events).toHaveLength(0);
  });

  test("does not sync in-flight tenants from disk", async () => {
    const t = makeTenant({ name: "busy", vmPid: 100 });
    const registry = makeRegistry([t]);
    const inFlight = new Set(["busy"]);

    s.loadRegistry.mockReturnValue(
      okAsync(
        makeRegistry([makeTenant({ name: "busy", vmPid: 999 })]),
      ) as never,
    );

    handle = startWatchdog(singleTickConfig(), registry, inFlight);
    await waitForEvent(handle.emitter, "tick-complete");

    // In-flight tenant should NOT have been updated from disk
    expect(registry.tenants[0].vmPid).toBe(100);
  });

  test("does not remove in-flight tenants even if missing from disk", async () => {
    const t = makeTenant({ name: "busy" });
    const registry = makeRegistry([t]);
    const inFlight = new Set(["busy"]);

    s.loadRegistry.mockReturnValue(okAsync(makeRegistry([])) as never);

    handle = startWatchdog(singleTickConfig(), registry, inFlight);
    await waitForEvent(handle.emitter, "tick-complete");

    expect(registry.tenants).toHaveLength(1);
    expect(registry.tenants[0].name).toBe("busy");
  });

  test("increments repairAttempts after successful repair", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(okAsync([failCheck]) as never);
    s.runRepairs.mockReturnValue(
      okAsync([
        { repair: "vm.process", fixed: true, actions: ["restarted"] },
      ]) as never,
    );

    handle = startWatchdog(
      singleTickConfig({ repairCooldownMs: 0 }),
      registry,
      new Set(),
    );
    await waitForEvent(handle.emitter, "tick-complete");

    const state = handle.states()[t.name];
    expect(state.repairAttempts).toBe(1);
    expect(state.lastRepairAt).not.toBeNull();
  });

  test("skips check when runAllChecks fails", async () => {
    const t = makeTenant();
    const registry = makeRegistry([t]);
    s.loadRegistry.mockReturnValue(okAsync(registry) as never);
    s.runAllChecks.mockReturnValue(
      errAsync({
        code: "UNKNOWN",
        message: "unreachable",
      } as LobsterError) as never,
    );

    handle = startWatchdog(singleTickConfig(), registry, new Set());
    await waitForEvent(handle.emitter, "tick-complete");

    // State stays UNKNOWN — checks errored so no transition
    expect(handle.states()[t.name].state).toBe("UNKNOWN");
    expect(s.runRepairs).not.toHaveBeenCalled();
  });
});
