import { describe, expect, test } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { DEFAULT_CONFIG, EMPTY_REGISTRY } from "./config/defaults.js";
import {
  makeConfig,
  makeRegistry,
  makeTenant,
  unwrapErr,
  unwrapOk,
} from "./test-helpers.js";
import type { LobsterError } from "./types/index.js";

// ── makeTenant ──────────────────────────────────────────────────────────────

describe("makeTenant", () => {
  test("returns a valid tenant with defaults", () => {
    const t = makeTenant();
    expect(t.name).toBe("test-tenant");
    expect(t.vmId).toBe("vm-test-tenant");
    expect(t.cid).toBe(3);
    expect(t.ipAddress).toBe("10.0.0.2");
    expect(t.hostIp).toBe("10.0.0.1");
    expect(t.tapDev).toBe("tap-test-tenant");
    expect(t.gatewayPort).toBe(9000);
    expect(t.vmPid).toBe(12345);
    expect(t.status).toBe("active");
    expect(t.jailUid).toBe(10000);
    expect(t.suspendInfo).toBeNull();
    expect(t.createdAt).toBeString();
    expect(t.gatewayToken).toBeString();
    expect(t.agentToken).toBeString();
    expect(t.overlayPath).toBeString();
    expect(t.socketPath).toBeString();
  });

  test("applies overrides", () => {
    const t = makeTenant({ name: "custom", cid: 99, status: "suspended" });
    expect(t.name).toBe("custom");
    expect(t.cid).toBe(99);
    expect(t.status).toBe("suspended");
    expect(t.vmId).toBe("vm-test-tenant");
  });
});

// ── makeConfig ──────────────────────────────────────────────────────────────

describe("makeConfig", () => {
  test("returns DEFAULT_CONFIG when no overrides", () => {
    const c = makeConfig();
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  test("applies overrides", () => {
    const c = makeConfig({
      caddy: { ...DEFAULT_CONFIG.caddy, domain: "test.local" },
    });
    expect(c.caddy.domain).toBe("test.local");
    expect(c.jailer).toEqual(DEFAULT_CONFIG.jailer);
  });
});

// ── makeRegistry ────────────────────────────────────────────────────────────

describe("makeRegistry", () => {
  test("returns EMPTY_REGISTRY when no args", () => {
    const r = makeRegistry();
    expect(r).toEqual(EMPTY_REGISTRY);
    expect(r.tenants).toEqual([]);
  });

  test("accepts tenants array", () => {
    const t = makeTenant();
    const r = makeRegistry([t]);
    expect(r.tenants).toHaveLength(1);
    expect(r.tenants[0].name).toBe("test-tenant");
  });

  test("applies overrides", () => {
    const r = makeRegistry(undefined, { nextCid: 50 });
    expect(r.nextCid).toBe(50);
    expect(r.tenants).toEqual([]);
  });
});

// ── unwrapOk / unwrapErr ────────────────────────────────────────────────────

describe("unwrapOk", () => {
  test("extracts value from Ok", async () => {
    const result: ResultAsync<string, LobsterError> = okAsync("hello");
    const val = await unwrapOk(result);
    expect(val).toBe("hello");
  });

  test("throws on Err", async () => {
    const result: ResultAsync<string, LobsterError> = errAsync({
      code: "UNKNOWN" as const,
      message: "boom",
    });
    expect(unwrapOk(result)).rejects.toThrow("Expected Ok but got Err");
  });
});

describe("unwrapErr", () => {
  test("extracts error from Err", async () => {
    const result: ResultAsync<string, LobsterError> = errAsync({
      code: "TENANT_NOT_FOUND" as const,
      message: "nope",
    });
    const err = await unwrapErr(result);
    expect(err.code).toBe("TENANT_NOT_FOUND");
    expect(err.message).toBe("nope");
  });

  test("throws on Ok", async () => {
    const result: ResultAsync<string, LobsterError> = okAsync("hi");
    expect(unwrapErr(result)).rejects.toThrow("Expected Err but got Ok");
  });
});
