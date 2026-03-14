import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";

function createApp() {
  const app = new Hono();
  app.use("*", bearerAuth("test-token"));
  app.get("/test", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/openapi.json", (c) => c.json({ openapi: "3.1.0" }));
  return app;
}

describe("bearerAuth", () => {
  const app = createApp();

  test("returns 401 when no Authorization header", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("PERMISSION_DENIED");
  });

  test("returns 401 for wrong token", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 for correct token", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("returns 401 for Basic scheme", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Basic test-token" },
    });
    expect(res.status).toBe(401);
  });

  test("bypasses auth for /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("bypasses auth for /openapi.json", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
  });
});
