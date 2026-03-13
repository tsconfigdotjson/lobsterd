import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";
import * as execMod from "./exec.js";
import { generateKeypair, getPrivateKeyPath, removeKeypair } from "./ssh.js";

describe("getPrivateKeyPath", () => {
  test("returns correct path for tenant", () => {
    expect(getPrivateKeyPath("my-tenant")).toBe(
      "/var/lib/lobsterd/ssh/my-tenant/id_ed25519",
    );
  });
});

describe("generateKeypair", () => {
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execSpy = spyOn(execMod, "exec");
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test("chains 4 exec calls and returns trimmed public key", async () => {
    const okResult = (stdout = ""): ExecResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
    });

    execSpy
      .mockReturnValueOnce(okAsync(okResult())) // mkdir -p
      .mockReturnValueOnce(okAsync(okResult())) // ssh-keygen
      .mockReturnValueOnce(okAsync(okResult())) // chmod 600
      .mockReturnValueOnce(okAsync(okResult("ssh-ed25519 AAAA test\n"))); // cat pub

    const result = await generateKeypair("my-tenant");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("ssh-ed25519 AAAA test");
    expect(execSpy).toHaveBeenCalledTimes(4);
  });
});

describe("removeKeypair", () => {
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execSpy = spyOn(execMod, "exec");
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test("returns Ok when exec succeeds", async () => {
    execSpy.mockReturnValueOnce(
      okAsync({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const result = await removeKeypair("my-tenant");
    expect(result.isOk()).toBe(true);
  });

  test("returns Ok even when exec fails (soft-fail via orElse)", async () => {
    const error: LobsterError = {
      code: "EXEC_FAILED",
      message: "rm failed",
    };
    execSpy.mockReturnValueOnce(errAsync(error));

    const result = await removeKeypair("my-tenant");
    expect(result.isOk()).toBe(true);
  });
});
