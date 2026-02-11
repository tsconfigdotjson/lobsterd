import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  readFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  BUNDLED_CERTS_DIR,
  CERTS_DIR,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  EMPTY_REGISTRY,
  JAILER_BASE,
  KERNELS_DIR,
  LOBSTERD_BASE,
  ORIGIN_CERT_PATH,
  ORIGIN_KEY_PATH,
  OVERLAYS_DIR,
  REGISTRY_PATH,
  SOCKETS_DIR,
} from "../config/defaults.js";
import * as caddy from "../system/caddy.js";
import { exec, execUnchecked } from "../system/exec.js";
import * as network from "../system/network.js";
import type { LobsterdConfig, LobsterError } from "../types/index.js";

// ── stdin prompt helper ─────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirmYn(message: string): Promise<boolean> {
  const answer = await prompt(`${message} [Y/n] `);
  return answer === "" || answer.toLowerCase() === "y";
}

// ── prerequisite checks ─────────────────────────────────────────────────────

function checkLinux(): ResultAsync<void, LobsterError> {
  if (process.platform !== "linux") {
    return errAsync({
      code: "NOT_LINUX" as const,
      message: `lobsterd requires Linux. Detected: ${process.platform}`,
    });
  }
  return okAsync(undefined);
}

function checkRoot(): ResultAsync<void, LobsterError> {
  if (process.getuid?.() !== 0) {
    return errAsync({
      code: "NOT_ROOT" as const,
      message: "lobster init must be run as root (or with sudo)",
    });
  }
  return okAsync(undefined);
}

function checkKvm(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      try {
        accessSync("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        throw new Error(
          "/dev/kvm not found — KVM not available. Enable hardware virtualization in BIOS.",
        );
      }
    })(),
    (e) => ({
      code: "KVM_NOT_AVAILABLE" as const,
      message: e instanceof Error ? e.message : "/dev/kvm not accessible",
      cause: e,
    }),
  );
}

// ── ensure-with-install helpers ─────────────────────────────────────────────

const FC_VERSION = "1.14.1";
const KERNEL_VERSION = "6.1.155";
const FC_MINOR = "1.14";

function ensureFirecracker(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return execUnchecked(["test", "-x", config.firecracker.binaryPath]).andThen(
    (r) => {
      if (r.exitCode === 0) {
        return execUnchecked(["test", "-x", config.jailer.binaryPath]).andThen(
          (jr) => {
            if (jr.exitCode === 0) return okAsync(undefined);
            return installFirecracker(config);
          },
        );
      }
      return installFirecracker(config);
    },
  );
}

function installFirecracker(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const ok = await confirmYn(
        `Firecracker not found. Download v${FC_VERSION}?`,
      );
      if (!ok)
        throw new Error(
          `Firecracker binary not found at ${config.firecracker.binaryPath}`,
        );
    })(),
    (e) => ({
      code: "FIRECRACKER_NOT_FOUND" as const,
      message: e instanceof Error ? e.message : "Firecracker not found",
      cause: e,
    }),
  ).andThen(() => {
    const arch = process.arch === "x64" ? "x86_64" : process.arch;
    const tarUrl = `https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${arch}.tgz`;
    console.log(`  Downloading Firecracker v${FC_VERSION}...`);
    return exec(["curl", "-fSL", tarUrl, "-o", "/tmp/firecracker.tgz"], {
      timeout: 120_000,
    })
      .andThen(() =>
        exec(["tar", "xzf", "/tmp/firecracker.tgz", "-C", "/tmp"]),
      )
      .andThen(() => {
        const prefix = `/tmp/release-v${FC_VERSION}-${arch}`;
        return exec([
          "install",
          "-m",
          "0755",
          `${prefix}/firecracker-v${FC_VERSION}-${arch}`,
          config.firecracker.binaryPath,
        ]).andThen(() =>
          exec([
            "install",
            "-m",
            "0755",
            `${prefix}/jailer-v${FC_VERSION}-${arch}`,
            config.jailer.binaryPath,
          ]),
        );
      })
      .andThen(() =>
        exec(["rm", "-rf", "/tmp/firecracker.tgz", `/tmp/release-v${FC_VERSION}-${arch}`]),
      )
      .map(() => {
        console.log("  Firecracker installed.");
      });
  });
}

function ensureKernel(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    Bun.file(config.firecracker.kernelPath).exists(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to check kernel",
      cause: e,
    }),
  ).andThen((exists) => {
    if (exists) return okAsync(undefined);
    return ResultAsync.fromPromise(
      (async () => {
        const ok = await confirmYn(
          `Kernel not found. Download vmlinux ${KERNEL_VERSION}?`,
        );
        if (!ok)
          throw new Error(
            `Kernel image not found at ${config.firecracker.kernelPath}`,
          );
      })(),
      (e) => ({
        code: "FIRECRACKER_NOT_FOUND" as const,
        message: e instanceof Error ? e.message : "Kernel not found",
        cause: e,
      }),
    ).andThen(() => {
      const kernelUrl = `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v${FC_MINOR}/x86_64/vmlinux-${KERNEL_VERSION}`;
      console.log(`  Downloading kernel ${KERNEL_VERSION}...`);
      return exec(["mkdir", "-p", KERNELS_DIR])
        .andThen(() =>
          exec(
            [
              "curl",
              "-fSL",
              kernelUrl,
              "-o",
              config.firecracker.kernelPath,
            ],
            { timeout: 120_000 },
          ),
        )
        .map(() => {
          console.log("  Kernel installed.");
        });
    });
  });
}

function ensureRootfs(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    Bun.file(config.firecracker.rootfsPath).exists(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to check rootfs",
      cause: e,
    }),
  ).andThen((exists) => {
    if (exists) return okAsync(undefined);
    return ResultAsync.fromPromise(
      (async () => {
        const ok = await confirmYn(
          "Rootfs not found. Build Alpine rootfs? (takes a few minutes)",
        );
        if (!ok)
          throw new Error(
            `Root filesystem not found at ${config.firecracker.rootfsPath}`,
          );
      })(),
      (e) => ({
        code: "FIRECRACKER_NOT_FOUND" as const,
        message: e instanceof Error ? e.message : "Rootfs not found",
        cause: e,
      }),
    ).andThen(() => {
      const scriptDir = new URL("../../guest", import.meta.url).pathname;
      console.log("  Building rootfs (this may take a few minutes)...");
      return exec(["bash", `${scriptDir}/build-rootfs.sh`], {
        timeout: 600_000,
      })
        .andThen(() =>
          exec([
            "mv",
            `${scriptDir}/rootfs.ext4`,
            config.firecracker.rootfsPath,
          ]),
        )
        .map(() => {
          console.log("  Rootfs built.");
        });
    });
  });
}

function ensureCaddy(): ResultAsync<void, LobsterError> {
  return execUnchecked(["which", "caddy"]).andThen((r) => {
    if (r.exitCode === 0) return okAsync(undefined);
    return ResultAsync.fromPromise(
      (async () => {
        // Detect package manager
        const managers = ["apt-get", "dnf", "yum", "pacman"] as const;
        let pm: string | null = null;
        for (const m of managers) {
          const result = await execUnchecked(["which", m]);
          if (result.isOk() && result.value.exitCode === 0) {
            pm = m;
            break;
          }
        }
        if (!pm) throw new Error("Caddy not found and no supported package manager detected (apt-get, dnf, yum, pacman)");
        const ok = await confirmYn(`Caddy not found. Install via ${pm}?`);
        if (!ok) throw new Error("Caddy is required but not installed");
        return pm;
      })(),
      (e) => ({
        code: "EXEC_FAILED" as const,
        message: e instanceof Error ? e.message : "Caddy not found",
        cause: e,
      }),
    ).andThen((pm) => {
      console.log(`  Installing Caddy via ${pm}...`);
      const installCmd =
        pm === "pacman"
          ? ["pacman", "-S", "--noconfirm", "caddy"]
          : [pm, "install", "-y", "caddy"];
      return exec(installCmd, { timeout: 120_000 }).map(() => {
        console.log("  Caddy installed.");
      });
    });
  });
}

// ── directory / config / cert helpers ───────────────────────────────────────

function ensureDirs(): ResultAsync<void, LobsterError> {
  return exec([
    "mkdir",
    "-p",
    CONFIG_DIR,
    CERTS_DIR,
    LOBSTERD_BASE,
    OVERLAYS_DIR,
    SOCKETS_DIR,
    KERNELS_DIR,
    JAILER_BASE,
  ]).andThen(() => {
    // 711: root rw, others can only traverse (needed for Caddy to reach certs/)
    chmodSync(CONFIG_DIR, 0o711);
    chmodSync(CERTS_DIR, 0o755);
    return okAsync(undefined);
  });
}

function installOriginCerts(): ResultAsync<boolean, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const bundledCert = Bun.file(`${BUNDLED_CERTS_DIR}/origin.pem`);
      const bundledKey = Bun.file(`${BUNDLED_CERTS_DIR}/origin-key.pem`);
      if (!(await bundledCert.exists()) || !(await bundledKey.exists())) {
        return false;
      }
      // Skip empty placeholder files
      if (bundledCert.size === 0 || bundledKey.size === 0) {
        return false;
      }
      await Bun.write(ORIGIN_CERT_PATH, bundledCert);
      await Bun.write(ORIGIN_KEY_PATH, bundledKey);
      chmodSync(ORIGIN_CERT_PATH, 0o644);
      chmodSync(ORIGIN_KEY_PATH, 0o640);
      // Caddy runs as user "caddy" and needs group-read access to the key
      const { execSync } = await import("node:child_process");
      try {
        execSync(`chown root:caddy ${ORIGIN_KEY_PATH}`);
      } catch {
        // Caddy group may not exist; fall back to world-readable
        chmodSync(ORIGIN_KEY_PATH, 0o644);
      }
      return true;
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to install origin certs",
      cause: e,
    }),
  );
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

function writeDefaultConfig(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(CONFIG_PATH))) {
        await Bun.write(
          CONFIG_PATH,
          `${JSON.stringify(config, null, 2)}\n`,
        );
        chmodSync(CONFIG_PATH, 0o600);
      }
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to write default config",
      cause: e,
    }),
  );
}

function writeEmptyRegistry(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(REGISTRY_PATH))) {
        await Bun.write(
          REGISTRY_PATH,
          `${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`,
        );
        chmodSync(REGISTRY_PATH, 0o600);
      }
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to write empty registry",
      cause: e,
    }),
  );
}

// ── public interface ────────────────────────────────────────────────────────

export interface InitResult {
  kvmAvailable: boolean;
  firecrackerFound: boolean;
  jailerFound: boolean;
  kernelFound: boolean;
  rootfsFound: boolean;
  dirsCreated: boolean;
  configCreated: boolean;
  certsInstalled: boolean;
  ipForwardingEnabled: boolean;
  caddyConfigured: boolean;
  warnings: string[];
}

export function runInit(
  initialConfig: LobsterdConfig = DEFAULT_CONFIG,
  domain?: string,
): ResultAsync<InitResult, LobsterError> {
  let config = initialConfig;
  if (domain) {
    config = { ...config, caddy: { ...config.caddy, domain } };
  }

  const result: InitResult = {
    kvmAvailable: false,
    firecrackerFound: false,
    jailerFound: false,
    kernelFound: false,
    rootfsFound: false,
    dirsCreated: false,
    configCreated: false,
    certsInstalled: false,
    ipForwardingEnabled: false,
    caddyConfigured: false,
    warnings: [],
  };

  return checkLinux()
    .andThen(() => checkRoot())
    .andThen(() => checkKvm())
    .andThen(() => {
      result.kvmAvailable = true;

      // Check for insecure host configuration
      try {
        const smtActive = readFileSync(
          "/sys/devices/system/cpu/smt/active",
          "utf-8",
        ).trim();
        if (smtActive === "1") {
          result.warnings.push(
            'SMT is enabled — add "nosmt" to kernel boot parameters for side-channel protection',
          );
        }
      } catch {
        /* SMT file may not exist on single-core or non-x86 */
      }

      try {
        const ksmRun = readFileSync("/sys/kernel/mm/ksm/run", "utf-8").trim();
        if (ksmRun !== "0") {
          result.warnings.push(
            'KSM is active — run "echo 0 > /sys/kernel/mm/ksm/run" to prevent page dedup side-channels',
          );
        }
      } catch {
        /* KSM may not be available */
      }

      return okAsync(undefined);
    })
    .andThen(() => ensureFirecracker(config))
    .andThen(() => {
      result.firecrackerFound = true;
      result.jailerFound = true;
      return ensureKernel(config);
    })
    .andThen(() => {
      result.kernelFound = true;
      return ensureRootfs(config);
    })
    .andThen(() => {
      result.rootfsFound = true;
      return ensureDirs();
    })
    .andThen(() => {
      result.dirsCreated = true;
      return writeDefaultConfig(config);
    })
    .andThen(() => writeEmptyRegistry())
    .andThen(() => {
      result.configCreated = true;
      return installOriginCerts();
    })
    .andThen((installed) => {
      result.certsInstalled = installed;
      // If certs were installed and no TLS config was explicitly set, use them
      if (installed && !config.caddy.tls) {
        config = {
          ...config,
          caddy: {
            ...config.caddy,
            tls: { certPath: ORIGIN_CERT_PATH, keyPath: ORIGIN_KEY_PATH },
          },
        };
      }
      return network.enableIpForwarding();
    })
    .andThen(() => {
      result.ipForwardingEnabled = true;
      return network.ensureChains();
    })
    .andThen(() => ensureCaddy())
    .andThen(() => {
      return caddy.ensureCaddyRunning();
    })
    .andThen(() =>
      caddy.writeCaddyBaseConfig(
        config.caddy.adminApi,
        config.caddy.domain,
        config.caddy.tls,
      ),
    )
    .map(() => {
      result.caddyConfigured = true;
      return result;
    });
}
