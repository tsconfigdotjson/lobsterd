import { describe, expect, test } from "bun:test";
import type { LobsterError } from "../types/index.js";
import { errorToStatus, stripSecrets } from "./errors.js";

// ── errorToStatus ───────────────────────────────────────────────────────────

describe("errorToStatus", () => {
  test.each([
    ["TENANT_NOT_FOUND", 404],
    ["TENANT_EXISTS", 409],
    ["VSOCK_CONNECT_FAILED", 502],
    ["EXEC_TIMEOUT", 504],
    ["VALIDATION_FAILED", 422],
    ["LOCK_FAILED", 503],
    ["NOT_ROOT", 403],
    ["EXEC_FAILED", 500],
  ] as const)("%s -> %d", (code, expected) => {
    const err: LobsterError = { code, message: "test" };
    expect(errorToStatus(err)).toBe(expected);
  });
});

// ── stripSecrets ────────────────────────────────────────────────────────────

describe("stripSecrets", () => {
  test("strips cause from error", () => {
    const err: LobsterError = {
      code: "EXEC_FAILED",
      message: "boom",
      cause: new Error("secret stack trace"),
    };
    const stripped = stripSecrets(err);
    expect(stripped).toEqual({ code: "EXEC_FAILED", message: "boom" });
    expect("cause" in stripped).toBe(false);
  });

  test("returns code and message for error without cause", () => {
    const err: LobsterError = { code: "UNKNOWN", message: "oops" };
    const stripped = stripSecrets(err);
    expect(stripped).toEqual({ code: "UNKNOWN", message: "oops" });
  });
});
