import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { okAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import * as exec from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import { makeConfig, makeTenant } from "../test-helpers.js";
import type { GuestStats, LobsterError } from "../types/index.js";
import { runAllChecks, runQuickChecks } from "./index.js";

let healthPingSpy: ReturnType<typeof spyOn>;
let getStatsSpy: ReturnType<typeof spyOn>;
let execUncheckedSpy: ReturnType<typeof spyOn>;
let listRoutesSpy: ReturnType<typeof spyOn>;
let killSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  killSpy = spyOn(process, "kill").mockImplementation(() => true);
  healthPingSpy = spyOn(vsock, "healthPing").mockReturnValue(
    okAsync(true) as never,
  );
  execUncheckedSpy = spyOn(exec, "execUnchecked").mockReturnValue(
    okAsync({ exitCode: 0, stdout: "", stderr: "" }) as never,
  );
  getStatsSpy = spyOn(vsock, "getStats").mockReturnValue(
    okAsync<GuestStats, LobsterError>({
      gatewayPid: 1,
      memoryKb: 1024,
      activeConnections: 0,
    }) as never,
  );
  listRoutesSpy = spyOn(caddy, "listRoutes").mockReturnValue(
    okAsync([
      { "@id": "lobster-test-tenant" },
      { "@id": "lobster-test-tenant-ws" },
    ]) as never,
  );
});

afterEach(() => {
  killSpy.mockRestore();
  healthPingSpy.mockRestore();
  execUncheckedSpy.mockRestore();
  getStatsSpy.mockRestore();
  listRoutesSpy.mockRestore();
});

describe("runAllChecks", () => {
  test("combines VM and network checks into flat array", async () => {
    const tenant = makeTenant();
    const config = makeConfig();
    const results = (await runAllChecks(tenant, config))._unsafeUnwrap();
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.check)).toEqual([
      "vm.process",
      "vm.responsive",
      "net.tap",
      "net.gateway",
      "net.caddy-route",
    ]);
  });
});

describe("runQuickChecks", () => {
  test("returns only VM checks", async () => {
    const tenant = makeTenant();
    const config = makeConfig();
    const results = (await runQuickChecks(tenant, config))._unsafeUnwrap();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.check)).toEqual([
      "vm.process",
      "vm.responsive",
    ]);
  });
});
