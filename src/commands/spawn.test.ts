import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as loader from "../config/loader.js";
import * as caddy from "../system/caddy.js";
import * as fc from "../system/firecracker.js";
import * as image from "../system/image.js";
import * as jailer from "../system/jailer.js";
import * as network from "../system/network.js";
import * as ssh from "../system/ssh.js";
import * as vsock from "../system/vsock.js";
import {
  makeConfig,
  makeRegistry,
  unwrapErr,
  unwrapOk,
} from "../test-helpers.js";
import type { LobsterError } from "../types/index.js";
import { computeSubnetIps, runSpawn } from "./spawn.js";

// ── Pure unit tests (no mocks) ──────────────────────────────────────────────

describe("computeSubnetIps", () => {
  test("index 0 -> 10.0.0.1 / 10.0.0.2", () => {
    const { hostIp, guestIp } = computeSubnetIps("10.0.0.0", 0);
    expect(hostIp).toBe("10.0.0.1");
    expect(guestIp).toBe("10.0.0.2");
  });

  test("index 1 -> 10.0.0.5 / 10.0.0.6", () => {
    const { hostIp, guestIp } = computeSubnetIps("10.0.0.0", 1);
    expect(hostIp).toBe("10.0.0.5");
    expect(guestIp).toBe("10.0.0.6");
  });

  test("index 63 -> correct /30 subnet", () => {
    const { hostIp, guestIp } = computeSubnetIps("10.0.0.0", 63);
    expect(hostIp).toBe("10.0.0.253");
    expect(guestIp).toBe("10.0.0.254");
  });

  test("works with 172.16.0.0 base", () => {
    const { hostIp, guestIp } = computeSubnetIps("172.16.0.0", 0);
    expect(hostIp).toBe("172.16.0.1");
    expect(guestIp).toBe("172.16.0.2");
  });
});

// ── Integration tests (all deps spied) ──────────────────────────────────────

let s: Record<string, ReturnType<typeof spyOn>>;

beforeEach(() => {
  s = {
    loadConfig: spyOn(loader, "loadConfig").mockReturnValue(
      okAsync(makeConfig()) as never,
    ),
    loadRegistry: spyOn(loader, "loadRegistry").mockReturnValue(
      okAsync(makeRegistry([])) as never,
    ),
    saveRegistry: spyOn(loader, "saveRegistry").mockReturnValue(
      okAsync(undefined) as never,
    ),
    createOverlay: spyOn(image, "createOverlay").mockReturnValue(
      okAsync(undefined) as never,
    ),
    deleteOverlay: spyOn(image, "deleteOverlay").mockReturnValue(
      okAsync(undefined) as never,
    ),
    createTap: spyOn(network, "createTap").mockReturnValue(
      okAsync(undefined) as never,
    ),
    deleteTap: spyOn(network, "deleteTap").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addNat: spyOn(network, "addNat").mockReturnValue(
      okAsync(undefined) as never,
    ),
    removeNat: spyOn(network, "removeNat").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addIsolationRules: spyOn(network, "addIsolationRules").mockReturnValue(
      okAsync(undefined) as never,
    ),
    removeIsolationRules: spyOn(
      network,
      "removeIsolationRules",
    ).mockReturnValue(okAsync(undefined) as never),
    addAgentLockdownRules: spyOn(
      network,
      "addAgentLockdownRules",
    ).mockReturnValue(okAsync(undefined) as never),
    removeAgentLockdownRules: spyOn(
      network,
      "removeAgentLockdownRules",
    ).mockReturnValue(okAsync(undefined) as never),
    cleanupChroot: spyOn(jailer, "cleanupChroot").mockReturnValue(
      okAsync(undefined) as never,
    ),
    linkChrootFiles: spyOn(jailer, "linkChrootFiles").mockReturnValue(
      okAsync(undefined) as never,
    ),
    buildJailerArgs: spyOn(jailer, "buildJailerArgs").mockReturnValue([
      "jailer",
      "--id",
      "test",
    ] as never),
    getApiSocketPath: spyOn(jailer, "getApiSocketPath").mockReturnValue(
      "/tmp/test.sock" as never,
    ),
    configureVm: spyOn(fc, "configureVm").mockReturnValue(
      okAsync(undefined) as never,
    ),
    setBootSource: spyOn(fc, "setBootSource").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addDrive: spyOn(fc, "addDrive").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addNetworkInterface: spyOn(fc, "addNetworkInterface").mockReturnValue(
      okAsync(undefined) as never,
    ),
    startInstance: spyOn(fc, "startInstance").mockReturnValue(
      okAsync(undefined) as never,
    ),
    waitForAgent: spyOn(vsock, "waitForAgent").mockReturnValue(
      okAsync(undefined) as never,
    ),
    injectSecrets: spyOn(vsock, "injectSecrets").mockReturnValue(
      okAsync(undefined) as never,
    ),
    addRoute: spyOn(caddy, "addRoute").mockReturnValue(
      okAsync(undefined) as never,
    ),
    removeRoute: spyOn(caddy, "removeRoute").mockReturnValue(
      okAsync(undefined) as never,
    ),
    generateKeypair: spyOn(ssh, "generateKeypair").mockReturnValue(
      okAsync("ssh-ed25519 AAAA test") as never,
    ),
    removeKeypair: spyOn(ssh, "removeKeypair").mockReturnValue(
      okAsync(undefined) as never,
    ),
    bunSpawn: spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          pid: 99999,
          unref: () => {},
          exited: Promise.resolve(0),
        }) as never,
    ),
    bunSleep: spyOn(Bun, "sleep").mockResolvedValue(undefined as never),
  };
});

afterEach(() => {
  for (const spy of Object.values(s)) {
    spy.mockRestore();
  }
});

describe("runSpawn", () => {
  test("rejects invalid tenant name with VALIDATION_FAILED", async () => {
    const err = await unwrapErr(runSpawn("INVALID!"));
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  test("rejects duplicate tenant name with TENANT_EXISTS", async () => {
    s.loadRegistry.mockReturnValue(
      okAsync(
        makeRegistry([
          {
            name: "taken",
            vmId: "vm-taken",
            cid: 3,
            ipAddress: "10.0.0.2",
            hostIp: "10.0.0.1",
            tapDev: "tap-taken",
            gatewayPort: 9000,
            overlayPath: "/tmp/taken.ext4",
            socketPath: "/tmp/taken.sock",
            vmPid: 1,
            createdAt: "2025-01-01T00:00:00.000Z",
            status: "active" as const,
            gatewayToken: "gw",
            jailUid: 10000,
            agentToken: "ag",
            suspendInfo: null,
          },
        ]),
      ) as never,
    );
    const err = await unwrapErr(runSpawn("taken"));
    expect(err.code).toBe("TENANT_EXISTS");
  });

  test("happy path returns Tenant with correct properties", async () => {
    const tenant = await unwrapOk(runSpawn("my-tenant"));
    expect(tenant.name).toBe("my-tenant");
    expect(tenant.vmId).toBe("vm-my-tenant");
    expect(tenant.tapDev).toBe("tap-my-tenant");
    expect(tenant.cid).toBe(3);
    expect(tenant.status).toBe("active");
    expect(tenant.vmPid).toBe(99999);
    // nextSubnetIndex=1 → computeSubnetIps("10.0.0.0", 1)
    expect(tenant.ipAddress).toBe("10.0.0.6");
    expect(tenant.hostIp).toBe("10.0.0.5");

    expect(s.createOverlay).toHaveBeenCalledTimes(1);
    expect(s.createTap).toHaveBeenCalledTimes(1);
    expect(s.addNat).toHaveBeenCalledTimes(1);
    expect(s.addIsolationRules).toHaveBeenCalledTimes(1);
    expect(s.configureVm).toHaveBeenCalledTimes(1);
    expect(s.startInstance).toHaveBeenCalledTimes(1);
    expect(s.waitForAgent).toHaveBeenCalledTimes(1);
    expect(s.generateKeypair).toHaveBeenCalledTimes(1);
    expect(s.injectSecrets).toHaveBeenCalledTimes(1);
    expect(s.addRoute).toHaveBeenCalledTimes(1);
    expect(s.saveRegistry).toHaveBeenCalledTimes(1);
  });

  test("rolls back on createTap failure", async () => {
    s.createTap.mockReturnValue(
      errAsync<void, LobsterError>({
        code: "TAP_CREATE_FAILED",
        message: "mock tap failure",
      }) as never,
    );

    const err = await unwrapErr(runSpawn("my-tenant"));
    expect(err.code).toBe("TAP_CREATE_FAILED");
    expect(err.message).toContain("rolled back 1/1 steps");
    // Only undo pushed before createTap is deleteOverlay
    expect(s.deleteOverlay).toHaveBeenCalledTimes(1);
    // Nothing after createTap should have run
    expect(s.addNat).not.toHaveBeenCalled();
  });
});
