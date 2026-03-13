import { afterEach, describe, expect, spyOn, test } from "bun:test";

const fetchSpy = spyOn(globalThis, "fetch");

const {
  configureVm,
  setBootSource,
  addDrive,
  addNetworkInterface,
  startInstance,
  pauseVm,
  resumeVm,
  createSnapshot,
  loadSnapshot,
} = await import("./firecracker.js");

afterEach(() => {
  fetchSpy.mockReset();
});

function okResponse(body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : "", {
    status: 204,
    statusText: "No Content",
  });
}

function errResponse(status: number, text: string): Response {
  return new Response(text, { status, statusText: "Error" });
}

function lastFetchCall(): {
  url: string;
  init: RequestInit & { unix?: string };
} {
  const calls = fetchSpy.mock.calls;
  const last = calls[calls.length - 1];
  return {
    url: last[0] as string,
    init: last[1] as RequestInit & { unix?: string },
  };
}

function lastBody(): Record<string, unknown> {
  const { init } = lastFetchCall();
  return JSON.parse(init.body as string);
}

describe("configureVm", () => {
  test("sends PUT /machine-config with unix socket", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await configureVm("/tmp/fc.sock", {
      vcpuCount: 2,
      memSizeMib: 256,
    });
    expect(result.isOk()).toBe(true);

    const { url, init } = lastFetchCall();
    expect(url).toBe("http://localhost/machine-config");
    expect(init.method).toBe("PUT");
    expect(init.unix).toBe("/tmp/fc.sock");
    expect(lastBody()).toEqual({ vcpu_count: 2, mem_size_mib: 256 });
  });
});

describe("setBootSource", () => {
  test("sends PUT /boot-source", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await setBootSource(
      "/tmp/fc.sock",
      "/vmlinux",
      "console=ttyS0",
    );
    expect(result.isOk()).toBe(true);

    const body = lastBody();
    expect(body.kernel_image_path).toBe("/vmlinux");
    expect(body.boot_args).toBe("console=ttyS0");
    expect(lastFetchCall().init.unix).toBe("/tmp/fc.sock");
  });
});

describe("addDrive", () => {
  test("sends PUT /drives/:id without rate limiter", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await addDrive(
      "/tmp/fc.sock",
      "rootfs",
      "/rootfs.ext4",
      true,
    );
    expect(result.isOk()).toBe(true);

    const body = lastBody();
    expect(body.drive_id).toBe("rootfs");
    expect(body.path_on_host).toBe("/rootfs.ext4");
    expect(body.is_root_device).toBe(true);
    expect(body.is_read_only).toBe(true);
    expect(body.rate_limiter).toBeUndefined();

    const { url } = lastFetchCall();
    expect(url).toBe("http://localhost/drives/rootfs");
  });

  test("includes rate limiter when provided", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await addDrive("/tmp/fc.sock", "data", "/data.ext4", false, {
      bandwidth: { size: 1000, refillTime: 100 },
    });
    expect(result.isOk()).toBe(true);

    const body = lastBody();
    expect(body.is_root_device).toBe(false);
    expect(body.rate_limiter).toEqual({
      bandwidth: { size: 1000, one_time_burst: 0, refill_time: 100 },
    });
  });
});

describe("addNetworkInterface", () => {
  test("sends PUT /network-interfaces/:id", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await addNetworkInterface("/tmp/fc.sock", "eth0", "tap0");
    expect(result.isOk()).toBe(true);

    const { url } = lastFetchCall();
    expect(url).toBe("http://localhost/network-interfaces/eth0");
    const body = lastBody();
    expect(body.iface_id).toBe("eth0");
    expect(body.host_dev_name).toBe("tap0");
    expect(lastFetchCall().init.unix).toBe("/tmp/fc.sock");
  });
});

describe("startInstance", () => {
  test("sends PUT /actions with InstanceStart", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await startInstance("/tmp/fc.sock");
    expect(result.isOk()).toBe(true);

    expect(lastBody()).toEqual({ action_type: "InstanceStart" });
    expect(lastFetchCall().init.unix).toBe("/tmp/fc.sock");
  });
});

describe("pauseVm", () => {
  test("sends PATCH /vm with Paused", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await pauseVm("/tmp/fc.sock");
    expect(result.isOk()).toBe(true);

    expect(lastFetchCall().init.method).toBe("PATCH");
    expect(lastBody()).toEqual({ state: "Paused" });
  });
});

describe("resumeVm", () => {
  test("sends PATCH /vm with Resumed", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await resumeVm("/tmp/fc.sock");
    expect(result.isOk()).toBe(true);

    expect(lastBody()).toEqual({ state: "Resumed" });
  });
});

describe("createSnapshot", () => {
  test("sends PUT /snapshot/create", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await createSnapshot(
      "/tmp/fc.sock",
      "/snap.bin",
      "/mem.bin",
    );
    expect(result.isOk()).toBe(true);

    const body = lastBody();
    expect(body.snapshot_type).toBe("Full");
    expect(body.snapshot_path).toBe("/snap.bin");
    expect(body.mem_file_path).toBe("/mem.bin");
  });

  test("returns SNAPSHOT_FAILED on error", async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(500, "snap err"));

    const result = await createSnapshot(
      "/tmp/fc.sock",
      "/snap.bin",
      "/mem.bin",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("SNAPSHOT_FAILED");
  });
});

describe("loadSnapshot", () => {
  test("sends PUT /snapshot/load with resume_vm", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await loadSnapshot("/tmp/fc.sock", "/snap.bin", "/mem.bin");
    expect(result.isOk()).toBe(true);

    const body = lastBody();
    expect(body.snapshot_path).toBe("/snap.bin");
    expect(body.mem_file_path).toBe("/mem.bin");
    expect(body.resume_vm).toBe(true);
  });

  test("returns SNAPSHOT_FAILED on error", async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(500, "load err"));

    const result = await loadSnapshot("/tmp/fc.sock", "/snap.bin", "/mem.bin");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("SNAPSHOT_FAILED");
  });
});
