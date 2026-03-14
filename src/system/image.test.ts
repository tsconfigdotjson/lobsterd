import { describe, expect, mock, test } from "bun:test";
import { err, ok, type ResultAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";

const execMock = mock();

mock.module("./exec.js", () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

const { createOverlay, deleteOverlay, resizeOverlay } = await import(
  "./image.js"
);

function okExec(): ResultAsync<ExecResult, LobsterError> {
  return ok({ exitCode: 0, stdout: "", stderr: "" }) as unknown as ResultAsync<
    ExecResult,
    LobsterError
  >;
}

function errExec(msg: string): ResultAsync<ExecResult, LobsterError> {
  return err({
    code: "EXEC_FAILED" as const,
    message: msg,
  }) as unknown as ResultAsync<ExecResult, LobsterError>;
}

describe("createOverlay", () => {
  test("calls truncate then mkfs.ext4", async () => {
    execMock.mockReturnValueOnce(okExec());
    execMock.mockReturnValueOnce(okExec());

    const result = await createOverlay("/tmp/overlay.ext4", 512);
    expect(result.isOk()).toBe(true);

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][0]).toEqual([
      "truncate",
      "-s",
      "512M",
      "/tmp/overlay.ext4",
    ]);
    expect(execMock.mock.calls[1][0]).toEqual([
      "mkfs.ext4",
      "-F",
      "-q",
      "/tmp/overlay.ext4",
    ]);
  });

  test("propagates error with OVERLAY_CREATE_FAILED", async () => {
    execMock.mockReturnValueOnce(errExec("truncate failed"));

    const result = await createOverlay("/tmp/overlay.ext4", 512);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("OVERLAY_CREATE_FAILED");
  });
});

describe("deleteOverlay", () => {
  test("calls rm -f", async () => {
    execMock.mockReset();
    execMock.mockReturnValueOnce(okExec());

    const result = await deleteOverlay("/tmp/overlay.ext4");
    expect(result.isOk()).toBe(true);

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0]).toEqual([
      "rm",
      "-f",
      "/tmp/overlay.ext4",
    ]);
  });
});

describe("resizeOverlay", () => {
  test("calls truncate, e2fsck, resize2fs", async () => {
    execMock.mockReset();
    execMock.mockReturnValueOnce(okExec());
    execMock.mockReturnValueOnce(okExec());
    execMock.mockReturnValueOnce(okExec());

    const result = await resizeOverlay("/tmp/overlay.ext4", 1024);
    expect(result.isOk()).toBe(true);

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[0][0]).toEqual([
      "truncate",
      "-s",
      "1024M",
      "/tmp/overlay.ext4",
    ]);
    expect(execMock.mock.calls[1][0]).toEqual([
      "e2fsck",
      "-f",
      "-y",
      "/tmp/overlay.ext4",
    ]);
    expect(execMock.mock.calls[2][0]).toEqual([
      "resize2fs",
      "/tmp/overlay.ext4",
    ]);
  });

  test("propagates truncate error", async () => {
    execMock.mockReset();
    execMock.mockReturnValueOnce(errExec("truncate failed"));

    const result = await resizeOverlay("/tmp/overlay.ext4", 1024);
    expect(result.isErr()).toBe(true);
  });
});
