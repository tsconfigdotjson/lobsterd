import { describe, expect, test } from "bun:test";
import { makeConfig, makeRegistry, makeTenant } from "../test-helpers.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  buoyConfigSchema,
  lobsterdConfigSchema,
  suspendInfoSchema,
  TENANT_NAME_REGEX,
  tenantRegistrySchema,
  tenantSchema,
} from "./schema.js";

// ── TENANT_NAME_REGEX ───────────────────────────────────────────────────────

describe("TENANT_NAME_REGEX", () => {
  test.each(["my-tenant", "a", "tenant_1"])("accepts %s", (name) => {
    expect(TENANT_NAME_REGEX.test(name)).toBe(true);
  });

  test.each([
    ["uppercase", "MyTenant"],
    ["leading dash", "-tenant"],
    ["leading digit", "1tenant"],
    ["empty", ""],
    ["spaces", "my tenant"],
    ["dots", "my.tenant"],
  ])("rejects %s (%s)", (_label, name) => {
    expect(TENANT_NAME_REGEX.test(name)).toBe(false);
  });
});

// ── lobsterdConfigSchema ────────────────────────────────────────────────────

describe("lobsterdConfigSchema", () => {
  test("parses DEFAULT_CONFIG", () => {
    const result = lobsterdConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("rejects missing firecracker", () => {
    const { firecracker: _, ...rest } = DEFAULT_CONFIG;
    const result = lobsterdConfigSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("rejects vcpu 0", () => {
    const cfg = makeConfig({
      firecracker: { ...DEFAULT_CONFIG.firecracker, defaultVcpuCount: 0 },
    });
    const result = lobsterdConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects mem 64", () => {
    const cfg = makeConfig({
      firecracker: { ...DEFAULT_CONFIG.firecracker, defaultMemSizeMb: 64 },
    });
    const result = lobsterdConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });
});

// ── tenantSchema ────────────────────────────────────────────────────────────

describe("tenantSchema", () => {
  test("parses valid tenant from makeTenant()", () => {
    const result = tenantSchema.safeParse(makeTenant());
    expect(result.success).toBe(true);
  });

  test("rejects cid < 3", () => {
    const result = tenantSchema.safeParse(makeTenant({ cid: 2 }));
    expect(result.success).toBe(false);
  });

  test("rejects invalid IP", () => {
    const result = tenantSchema.safeParse(makeTenant({ ipAddress: "nope" }));
    expect(result.success).toBe(false);
  });

  test("rejects bad status", () => {
    const result = tenantSchema.safeParse({
      ...makeTenant(),
      status: "bogus",
    });
    expect(result.success).toBe(false);
  });

  test("rejects bad name", () => {
    const result = tenantSchema.safeParse(makeTenant({ name: "Bad-Name" }));
    expect(result.success).toBe(false);
  });
});

// ── tenantRegistrySchema ────────────────────────────────────────────────────

describe("tenantRegistrySchema", () => {
  test("parses valid registry", () => {
    const result = tenantRegistrySchema.safeParse(makeRegistry());
    expect(result.success).toBe(true);
  });

  test("parses registry with tenants", () => {
    const result = tenantRegistrySchema.safeParse(makeRegistry([makeTenant()]));
    expect(result.success).toBe(true);
  });

  test("rejects nextCid 2", () => {
    const result = tenantRegistrySchema.safeParse(
      makeRegistry(undefined, { nextCid: 2 }),
    );
    expect(result.success).toBe(false);
  });
});

// ── buoyConfigSchema ────────────────────────────────────────────────────────

describe("buoyConfigSchema", () => {
  test("parses valid buoy config", () => {
    const result = buoyConfigSchema.safeParse({
      port: 7070,
      host: "127.0.0.1",
      apiToken: "secret",
      agentLockdown: true,
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty apiToken", () => {
    const result = buoyConfigSchema.safeParse({
      port: 7070,
      host: "127.0.0.1",
      apiToken: "",
      agentLockdown: true,
    });
    expect(result.success).toBe(false);
  });
});

// ── suspendInfoSchema ───────────────────────────────────────────────────────

describe("suspendInfoSchema", () => {
  test("parses valid suspend info", () => {
    const result = suspendInfoSchema.safeParse({
      suspendedAt: "2025-01-01T00:00:00.000Z",
      snapshotDir: "/snapshots/test",
      cronSchedules: [],
      nextWakeAtMs: null,
      wakeReason: null,
      lastRxBytes: 0,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing snapshotDir", () => {
    const result = suspendInfoSchema.safeParse({
      suspendedAt: "2025-01-01T00:00:00.000Z",
      cronSchedules: [],
      nextWakeAtMs: null,
      lastRxBytes: 0,
    });
    expect(result.success).toBe(false);
  });
});
