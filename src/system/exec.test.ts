import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// Partial mock of Subprocess — only fields exec.ts actually reads
function makeProc(exitCode: number, stdout: string, stderr: string) {
  return {
    pid: 123,
    exited: Promise.resolve(exitCode),
    stdout: new Response(stdout).body as ReadableStream,
    stderr: new Response(stderr).body as ReadableStream,
    kill: mock(() => {}),
    unref: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

const spawnSpy = spyOn(Bun, "spawn");

const { exec, execUnchecked, getUid } = await import("./exec.js");

afterEach(() => {
  spawnSpy.mockReset();
});

describe("exec", () => {
  test("returns Ok on exit 0", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "hello\n", ""));

    const result = await exec(["echo", "hello"]);
    expect(result.isOk()).toBe(true);

    const val = result._unsafeUnwrap();
    expect(val.exitCode).toBe(0);
    expect(val.stdout).toBe("hello\n");
    expect(val.stderr).toBe("");

    const call = spawnSpy.mock.calls[0];
    expect(call[0]).toEqual(["echo", "hello"]);
  });

  test("returns Err on non-zero exit", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(1, "", "bad\n"));

    const result = await exec(["false"]);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe("EXEC_FAILED");
    expect(error.message).toContain("exit 1");
  });

  test("wraps with sudo when asUser is set", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "", ""));

    await exec(["ls", "/root"], { asUser: "nobody" });

    const call = spawnSpy.mock.calls[0];
    const args = call[0] as string[];
    expect(args[0]).toBe("sudo");
    expect(args[1]).toBe("-u");
    expect(args[2]).toBe("nobody");
    expect(args).toContain("ls");
    expect(args).toContain("/root");
  });

  test("passes env through to Bun.spawn", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "", ""));

    await exec(["env"], { env: { FOO: "bar" } });

    const call = spawnSpy.mock.calls[0];
    const opts = call[1] as { env: Record<string, string> };
    expect(opts.env.FOO).toBe("bar");
  });

  test("returns Err when Bun.spawn throws", async () => {
    spawnSpy.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    const result = await exec(["bad-cmd"]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("EXEC_FAILED");
  });
});

describe("execUnchecked", () => {
  test("returns Ok even on non-zero exit", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(42, "out", "err"));

    const result = await execUnchecked(["fail"]);
    expect(result.isOk()).toBe(true);

    const val = result._unsafeUnwrap();
    expect(val.exitCode).toBe(42);
    expect(val.stdout).toBe("out");
    expect(val.stderr).toBe("err");
  });

  test("wraps with sudo when asUser is set", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "", ""));

    await execUnchecked(["ls"], { asUser: "nobody" });

    const call = spawnSpy.mock.calls[0];
    const args = call[0] as string[];
    expect(args[0]).toBe("sudo");
    expect(args[1]).toBe("-u");
    expect(args[2]).toBe("nobody");
    expect(args).toContain("ls");
  });

  test("passes env with asUser and preserves env vars", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "", ""));

    await execUnchecked(["cmd"], { asUser: "user", env: { MY_VAR: "val" } });

    const call = spawnSpy.mock.calls[0];
    const args = call[0] as string[];
    expect(args[0]).toBe("sudo");
    expect(args).toContain("--preserve-env=MY_VAR");
    expect(args).toContain("cmd");
  });
});

describe("getUid", () => {
  test("parses uid from stdout", async () => {
    spawnSpy.mockReturnValueOnce(makeProc(0, "1000\n", ""));

    const result = await getUid("testuser");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(1000);

    const call = spawnSpy.mock.calls[0];
    expect(call[0]).toEqual(["id", "-u", "testuser"]);
  });
});
