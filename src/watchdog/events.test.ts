import { describe, expect, test } from "bun:test";
import { WatchdogEmitter } from "./events.js";

describe("WatchdogEmitter", () => {
  test("on + emit calls listener", () => {
    const emitter = new WatchdogEmitter();
    const calls: string[] = [];
    emitter.on("state-change", (data) => {
      calls.push(data.tenant);
    });
    emitter.emit("state-change", {
      tenant: "t1",
      from: "UNKNOWN",
      to: "HEALTHY",
    });
    expect(calls).toEqual(["t1"]);
  });

  test("multiple listeners receive events", () => {
    const emitter = new WatchdogEmitter();
    const a: string[] = [];
    const b: string[] = [];
    emitter.on("state-change", (data) => {
      a.push(data.tenant);
    });
    emitter.on("state-change", (data) => {
      b.push(data.tenant);
    });
    emitter.emit("state-change", {
      tenant: "t1",
      from: "UNKNOWN",
      to: "HEALTHY",
    });
    expect(a).toEqual(["t1"]);
    expect(b).toEqual(["t1"]);
  });

  test("unsubscribe removes listener", () => {
    const emitter = new WatchdogEmitter();
    const calls: string[] = [];
    const unsub = emitter.on("state-change", (data) => {
      calls.push(data.tenant);
    });
    emitter.emit("state-change", {
      tenant: "t1",
      from: "UNKNOWN",
      to: "HEALTHY",
    });
    unsub();
    emitter.emit("state-change", {
      tenant: "t2",
      from: "HEALTHY",
      to: "DEGRADED",
    });
    expect(calls).toEqual(["t1"]);
  });

  test("removeAllListeners clears all", () => {
    const emitter = new WatchdogEmitter();
    const calls: string[] = [];
    emitter.on("state-change", (data) => {
      calls.push(data.tenant);
    });
    emitter.on("suspend-start", (data) => {
      calls.push(data.tenant);
    });
    emitter.removeAllListeners();
    emitter.emit("state-change", {
      tenant: "t1",
      from: "UNKNOWN",
      to: "HEALTHY",
    });
    emitter.emit("suspend-start", { tenant: "t2" });
    expect(calls).toEqual([]);
  });

  test("emit with no listeners does not throw", () => {
    const emitter = new WatchdogEmitter();
    expect(() => {
      emitter.emit("state-change", {
        tenant: "t1",
        from: "UNKNOWN",
        to: "HEALTHY",
      });
    }).not.toThrow();
  });
});
