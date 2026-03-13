import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import * as exec from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import { makeConfig, makeTenant } from "../test-helpers.js";
import type { GuestStats, LobsterError } from "../types/index.js";
import {
  checkCaddyRoute,
  checkGatewayPort,
  checkTapDevice,
} from "./network.js";

let execUncheckedSpy: ReturnType<typeof spyOn>;
let getStatsSpy: ReturnType<typeof spyOn>;
let listRoutesSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  execUncheckedSpy = spyOn(exec, "execUnchecked");
  getStatsSpy = spyOn(vsock, "getStats");
  listRoutesSpy = spyOn(caddy, "listRoutes");
});

afterEach(() => {
  execUncheckedSpy.mockRestore();
  getStatsSpy.mockRestore();
  listRoutesSpy.mockRestore();
});

describe("checkTapDevice", () => {
  test("returns ok when exec exits 0", async () => {
    execUncheckedSpy.mockReturnValue(
      okAsync({ exitCode: 0, stdout: "", stderr: "" }) as never,
    );
    const tenant = makeTenant();
    const r = (await checkTapDevice(tenant))._unsafeUnwrap();
    expect(r.check).toBe("net.tap");
    expect(r.status).toBe("ok");
    expect(r.message).toContain(tenant.tapDev);
  });

  test("returns failed when exec exits non-zero", async () => {
    execUncheckedSpy.mockReturnValue(
      okAsync({ exitCode: 1, stdout: "", stderr: "not found" }) as never,
    );
    const tenant = makeTenant();
    const r = (await checkTapDevice(tenant))._unsafeUnwrap();
    expect(r.check).toBe("net.tap");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("not found");
  });

  test("returns failed when exec returns err", async () => {
    execUncheckedSpy.mockReturnValue(
      errAsync<never, LobsterError>({
        code: "EXEC_FAILED",
        message: "boom",
      }) as never,
    );
    const tenant = makeTenant();
    const r = (await checkTapDevice(tenant))._unsafeUnwrap();
    expect(r.check).toBe("net.tap");
    expect(r.status).toBe("failed");
  });
});

describe("checkGatewayPort", () => {
  test("skips check when tenant is suspended", async () => {
    const tenant = makeTenant({ status: "suspended" });
    const config = makeConfig();
    const r = (await checkGatewayPort(tenant, config))._unsafeUnwrap();
    expect(r.check).toBe("net.gateway");
    expect(r.status).toBe("ok");
    expect(r.message).toContain("suspended");
  });

  test("returns ok when gatewayPid is set", async () => {
    getStatsSpy.mockReturnValue(
      okAsync<GuestStats, LobsterError>({
        gatewayPid: 42,
        memoryKb: 1024,
        activeConnections: 0,
      }) as never,
    );
    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await checkGatewayPort(tenant, config))._unsafeUnwrap();
    expect(r.check).toBe("net.gateway");
    expect(r.status).toBe("ok");
    expect(r.message).toContain("42");
  });

  test("returns failed when gatewayPid is null", async () => {
    getStatsSpy.mockReturnValue(
      okAsync<GuestStats, LobsterError>({
        gatewayPid: null,
        memoryKb: 1024,
        activeConnections: 0,
      }) as never,
    );
    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await checkGatewayPort(tenant, config))._unsafeUnwrap();
    expect(r.check).toBe("net.gateway");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("not running");
  });

  test("returns failed when getStats returns err", async () => {
    getStatsSpy.mockReturnValue(
      errAsync<GuestStats, LobsterError>({
        code: "VSOCK_CONNECT_FAILED",
        message: "timeout",
      }) as never,
    );
    const tenant = makeTenant();
    const config = makeConfig();
    const r = (await checkGatewayPort(tenant, config))._unsafeUnwrap();
    expect(r.check).toBe("net.gateway");
    expect(r.status).toBe("failed");
  });
});

describe("checkCaddyRoute", () => {
  test("returns ok when both route IDs exist", async () => {
    listRoutesSpy.mockReturnValue(
      okAsync([
        { "@id": "lobster-test-tenant" },
        { "@id": "lobster-test-tenant-ws" },
        { "@id": "lobster-other" },
      ]) as never,
    );
    const tenant = makeTenant();
    const r = (
      await checkCaddyRoute(tenant, "http://localhost:2019")
    )._unsafeUnwrap();
    expect(r.check).toBe("net.caddy-route");
    expect(r.status).toBe("ok");
  });

  test("returns failed when http route is missing", async () => {
    listRoutesSpy.mockReturnValue(
      okAsync([{ "@id": "lobster-test-tenant-ws" }]) as never,
    );
    const tenant = makeTenant();
    const r = (
      await checkCaddyRoute(tenant, "http://localhost:2019")
    )._unsafeUnwrap();
    expect(r.check).toBe("net.caddy-route");
    expect(r.status).toBe("failed");
  });

  test("returns failed when ws route is missing", async () => {
    listRoutesSpy.mockReturnValue(
      okAsync([{ "@id": "lobster-test-tenant" }]) as never,
    );
    const tenant = makeTenant();
    const r = (
      await checkCaddyRoute(tenant, "http://localhost:2019")
    )._unsafeUnwrap();
    expect(r.check).toBe("net.caddy-route");
    expect(r.status).toBe("failed");
  });

  test("returns failed when listRoutes returns err", async () => {
    listRoutesSpy.mockReturnValue(
      errAsync<unknown[], LobsterError>({
        code: "CADDY_API_ERROR",
        message: "connection refused",
      }) as never,
    );
    const tenant = makeTenant();
    const r = (
      await checkCaddyRoute(tenant, "http://localhost:2019")
    )._unsafeUnwrap();
    expect(r.check).toBe("net.caddy-route");
    expect(r.status).toBe("failed");
  });
});
