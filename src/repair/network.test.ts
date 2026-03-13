import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import * as network from "../system/network.js";
import { makeConfig, makeTenant } from "../test-helpers.js";
import type { LobsterError } from "../types/index.js";
import { repairCaddyRoute, repairTap } from "./network.js";

let createTapSpy: ReturnType<typeof spyOn>;
let addNatSpy: ReturnType<typeof spyOn>;
let addIsolationRulesSpy: ReturnType<typeof spyOn>;
let removeRouteSpy: ReturnType<typeof spyOn>;
let addRouteSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  createTapSpy = spyOn(network, "createTap");
  addNatSpy = spyOn(network, "addNat");
  addIsolationRulesSpy = spyOn(network, "addIsolationRules");
  removeRouteSpy = spyOn(caddy, "removeRoute");
  addRouteSpy = spyOn(caddy, "addRoute");
});

afterEach(() => {
  createTapSpy.mockRestore();
  addNatSpy.mockRestore();
  addIsolationRulesSpy.mockRestore();
  removeRouteSpy.mockRestore();
  addRouteSpy.mockRestore();
});

describe("repairTap", () => {
  test("returns fixed:true when all network ops succeed", async () => {
    createTapSpy.mockReturnValue(okAsync(undefined) as never);
    addNatSpy.mockReturnValue(okAsync(undefined) as never);
    addIsolationRulesSpy.mockReturnValue(okAsync(undefined) as never);

    const tenant = makeTenant();
    const r = (await repairTap(tenant))._unsafeUnwrap();
    expect(r.repair).toBe("net.tap");
    expect(r.fixed).toBe(true);
    expect(r.actions).toHaveLength(3);
  });

  test("returns fixed:false when createTap fails", async () => {
    createTapSpy.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "TAP_CREATE_FAILED",
        message: "no perms",
      }) as never,
    );

    const tenant = makeTenant();
    const r = (await repairTap(tenant))._unsafeUnwrap();
    expect(r.repair).toBe("net.tap");
    expect(r.fixed).toBe(false);
  });

  test("returns fixed:false when addNat fails", async () => {
    createTapSpy.mockReturnValue(okAsync(undefined) as never);
    addNatSpy.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "EXEC_FAILED",
        message: "iptables error",
      }) as never,
    );

    const tenant = makeTenant();
    const r = (await repairTap(tenant))._unsafeUnwrap();
    expect(r.fixed).toBe(false);
  });
});

describe("repairCaddyRoute", () => {
  test("returns fixed:true when remove+add succeed", async () => {
    removeRouteSpy.mockReturnValue(okAsync(undefined) as never);
    addRouteSpy.mockReturnValue(okAsync(undefined) as never);

    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await repairCaddyRoute(tenant, config))._unsafeUnwrap();
    expect(r.repair).toBe("net.caddy-route");
    expect(r.fixed).toBe(true);
    expect(r.actions[0]).toContain(tenant.name);
  });

  test("returns fixed:false when removeRoute fails", async () => {
    removeRouteSpy.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "CADDY_API_ERROR",
        message: "refused",
      }) as never,
    );

    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await repairCaddyRoute(tenant, config))._unsafeUnwrap();
    expect(r.repair).toBe("net.caddy-route");
    expect(r.fixed).toBe(false);
  });

  test("returns fixed:false when addRoute fails", async () => {
    removeRouteSpy.mockReturnValue(okAsync(undefined) as never);
    addRouteSpy.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "CADDY_API_ERROR",
        message: "conflict",
      }) as never,
    );

    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await repairCaddyRoute(tenant, config))._unsafeUnwrap();
    expect(r.fixed).toBe(false);
  });
});
