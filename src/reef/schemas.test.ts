import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

// @hono/zod-openapi extends zod schemas with .openapi() for metadata.
// In test context the openapi registry crashes, so we mock the module
// and patch .openapi() as a no-op passthrough on the zod prototype.
for (const Proto of [
  z.ZodObject.prototype,
  z.ZodString.prototype,
  z.ZodEnum.prototype,
  z.ZodNumber.prototype,
  z.ZodArray.prototype,
]) {
  if (!("openapi" in Proto)) {
    Object.defineProperty(Proto, "openapi", {
      value: function openapi() {
        return this;
      },
      writable: true,
      configurable: true,
    });
  }
}

// Include createRoute and OpenAPIHono so other test files that also
// import from @hono/zod-openapi don't break when bun leaks mocks.
class FakeOpenAPIHono extends Hono {
  openapi(
    route: { method: string; path: string },
    handler: (c: unknown) => unknown,
  ) {
    this.on(route.method, [route.path], handler as never);
  }
}

mock.module("@hono/zod-openapi", () => ({
  z,
  createRoute: (config: unknown) => config,
  OpenAPIHono: FakeOpenAPIHono,
}));

const { HealthResponse, SpawnRequestBody, TenantNameParam, TenantResponse } =
  await import("./schemas.js");

// ── TenantNameParam ─────────────────────────────────────────────────────────

describe("TenantNameParam", () => {
  test("accepts valid tenant name", () => {
    const result = TenantNameParam.safeParse("my-tenant");
    expect(result.success).toBe(true);
  });

  test("rejects uppercase", () => {
    const result = TenantNameParam.safeParse("MyTenant");
    expect(result.success).toBe(false);
  });

  test("rejects empty", () => {
    const result = TenantNameParam.safeParse("");
    expect(result.success).toBe(false);
  });
});

// ── SpawnRequestBody ────────────────────────────────────────────────────────

describe("SpawnRequestBody", () => {
  test("accepts valid body", () => {
    const result = SpawnRequestBody.safeParse({ name: "test-tenant" });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const result = SpawnRequestBody.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects invalid name", () => {
    const result = SpawnRequestBody.safeParse({ name: "BAD!" });
    expect(result.success).toBe(false);
  });
});

// ── HealthResponse ──────────────────────────────────────────────────────────

describe("HealthResponse", () => {
  test("accepts valid response", () => {
    const result = HealthResponse.safeParse({
      status: "ok",
      uptime: 12345,
      tenantCount: 3,
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = HealthResponse.safeParse({
      status: "broken",
      uptime: 0,
      tenantCount: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing fields", () => {
    const result = HealthResponse.safeParse({ status: "ok" });
    expect(result.success).toBe(false);
  });
});

// ── TenantResponse ──────────────────────────────────────────────────────────

describe("TenantResponse", () => {
  test("accepts valid response", () => {
    const result = TenantResponse.safeParse({
      name: "test",
      cid: 3,
      ipAddress: "10.0.0.2",
      gatewayPort: 9000,
      vmPid: 12345,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null vmPid", () => {
    const result = TenantResponse.safeParse({
      name: "test",
      cid: 3,
      ipAddress: "10.0.0.2",
      gatewayPort: 9000,
      vmPid: null,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const result = TenantResponse.safeParse({
      cid: 3,
      ipAddress: "10.0.0.2",
      gatewayPort: 9000,
      vmPid: null,
      status: "active",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
