# Distributed Storage Design: StorageBackend Adapter + JuiceFS

This document is the complete implementation guide for adding distributed storage to lobsterd via a `StorageBackend` adapter pattern, with JuiceFS as the first distributed backend. It is written as a handoff to an implementing agent.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Storage Architecture](#2-current-storage-architecture)
3. [Adapter Pattern: StorageBackend Interface](#3-adapter-pattern-storagebackend-interface)
4. [Phase 1: Extract Local Backend](#4-phase-1-extract-local-backend)
5. [Phase 2: JuiceFS Backend](#5-phase-2-juicefs-backend)
6. [Fencing and Distributed Locking](#6-fencing-and-distributed-locking)
7. [Hard-Link to Bind Mount Migration](#7-hard-link-to-bind-mount-migration)
8. [Cache Sizing](#8-cache-sizing)
9. [Implementation Phases with AI Prompts](#9-implementation-phases-with-ai-prompts)

---

## 1. Problem Statement

lobsterd manages Firecracker microVMs on a single host. Each tenant gets a writable ext4 overlay filesystem. To enable multi-host shared hosting (tenants migrate between hosts on crash/rebalance), the overlay and snapshot storage must become distributed.

**Goal:** A tenant suspended on Host A can resume on Host B with all its data intact.

**Constraint:** Firecracker only supports virtio-blk (not virtio-fs). The overlay must be a file or block device that Firecracker can attach. The guest OS, agent, and overlay-init are untouched.

---

## 2. Current Storage Architecture

### 2.1 What Lives Where

```
/var/lib/lobsterd/
  overlays/
    {tenant}.ext4        <- Per-tenant writable overlay (default 4096 MB, sparse)
  snapshots/
    {tenant}/
      snapshot_file      <- VM device state (created during suspend)
      mem_file           <- VM memory dump (created during suspend)
  jailer/
    firecracker/
      {vmId}/
        root/
          vmlinux        <- Hard-linked from kernels/ (read-only)
          rootfs.ext4    <- Hard-linked from rootfs (read-only)
          overlay.ext4   <- Hard-linked from overlays/ (read-write)
          api.socket     <- Firecracker API socket
          snapshot_file  <- Temporary during suspend/resume
          mem_file       <- Temporary during suspend/resume
  kernels/
    vmlinux              <- Shared kernel image
  rootfs.ext4            <- Shared Alpine rootfs (2048 MB)
```

### 2.2 All Storage Operations (Exhaustive)

There are exactly **6 categories** of storage operations across the codebase:

| # | Operation | Current Implementation | Call Sites |
|---|-----------|----------------------|------------|
| 1 | **Create overlay** | `truncate -s {size}M` + `mkfs.ext4 -F -q` | `spawn.ts:139` via `image.ts:5-17` |
| 2 | **Delete overlay** | `rm -f {path}` | `evict.ts:133`, `spawn.ts:142` (rollback) via `image.ts:19-21` |
| 3 | **Attach overlay to chroot** | `ln -f overlayPath {root}/overlay.ext4` + `chown` | `spawn.ts:252-259`, `resume.ts:94-101`, `repair/vm.ts:69-76` via `jailer.ts:26-45` |
| 4 | **Persist snapshot** | `mkdir -p` + 2x `cp --sparse=always` from chroot to snapshots/ | `suspend.ts:179-195` (inline) |
| 5 | **Restore snapshot** | 2x `cp --sparse=always` from snapshots/ to chroot + `chown` | `resume.ts:110-131` (inline) |
| 6 | **Delete snapshot** | `rm -rf {snapshotDir}` | `resume.ts:152`, `evict.ts:52-53` (inline) |

Additional read-only operations (not abstracted):
- `snap.ts:56-69`: Export overlay to tar.gz (operational backup, not part of VM lifecycle)
- `image.ts:23-33`: `resizeOverlay()` exists but is never called

### 2.3 The Hard-Link Problem

The jailer creates a chroot at `/var/lib/lobsterd/jailer/firecracker/{vmId}/root/`. Files are hard-linked into it:

```typescript
// jailer.ts:35-38
exec(["ln", "-f", kernelPath, `${root}/vmlinux`])
  .andThen(() => exec(["ln", "-f", rootfsPath, `${root}/rootfs.ext4`]))
  .andThen(() => exec(["ln", "-f", overlayPath, `${root}/overlay.ext4`]))
  .andThen(() => exec(["chown", `${uid}:${uid}`, `${root}/overlay.ext4`]))
```

Hard links require source and target on the **same filesystem**. If the overlay lives on JuiceFS (a FUSE mount) and the chroot lives on the host's local filesystem, `ln -f` will fail with `EXDEV` (cross-device link). This is the primary technical challenge.

### 2.4 Tenant Type (Registry Schema)

```typescript
// src/types/index.ts:37-54
interface Tenant {
  name: string;
  vmId: string;
  cid: number;
  ipAddress: string;
  hostIp: string;
  tapDev: string;
  gatewayPort: number;
  overlayPath: string;      // <- Currently a local file path
  socketPath: string;
  vmPid: number | null;
  createdAt: string;
  status: TenantStatus;
  gatewayToken: string;
  jailUid: number;
  agentToken: string;
  suspendInfo: SuspendInfo | null;  // <- Contains snapshotDir: string
}
```

### 2.5 Config Schema

```typescript
// src/config/schema.ts:59-63
const overlayConfigSchema = z.object({
  baseDir: z.string().min(1),
  defaultSizeMb: z.number().int().min(256),
  snapshotRetention: z.number().int().min(0),
});
```

---

## 3. Adapter Pattern: StorageBackend Interface

### 3.1 Interface Definition

```typescript
// src/system/storage.ts

import type { ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";

/**
 * Opaque references returned by the backend.
 * - Local backend: these are absolute file paths.
 * - JuiceFS backend: these are paths relative to the JuiceFS mount.
 * - Future backends (S3, Ceph): could be URIs or keys.
 *
 * These values are serialized into the tenant registry as
 * Tenant.overlayRef and SuspendInfo.snapshotRef.
 */
export type OverlayRef = string;
export type SnapshotRef = string;

export interface StorageBackend {
  /** Create a new ext4 overlay for a tenant. Returns an opaque reference. */
  createOverlay(name: string, sizeMb: number): ResultAsync<OverlayRef, LobsterError>;

  /** Permanently delete a tenant's overlay. */
  deleteOverlay(ref: OverlayRef): ResultAsync<void, LobsterError>;

  /**
   * Make the overlay accessible inside a jailer chroot as `overlay.ext4`.
   * - Local backend: hard-link + chown
   * - JuiceFS backend: bind mount or copy
   */
  attachToChroot(
    ref: OverlayRef,
    chrootRoot: string,
    uid: number,
  ): ResultAsync<void, LobsterError>;

  /**
   * Release the overlay from the chroot. Must be called BEFORE cleanupChroot.
   * - Local backend: no-op (hard link is just a file, rm -rf handles it)
   * - JuiceFS backend: umount (if bind mount) or copy-back (if copy)
   */
  detachFromChroot(
    ref: OverlayRef,
    chrootRoot: string,
  ): ResultAsync<void, LobsterError>;

  /**
   * Copy VM snapshot files (snapshot_file, mem_file) from a jailer chroot
   * to persistent storage. Returns an opaque reference for later restore.
   */
  persistSnapshot(
    name: string,
    chrootRoot: string,
  ): ResultAsync<SnapshotRef, LobsterError>;

  /**
   * Restore VM snapshot files into a jailer chroot and set ownership.
   */
  restoreSnapshot(
    ref: SnapshotRef,
    chrootRoot: string,
    uid: number,
  ): ResultAsync<void, LobsterError>;

  /** Delete persisted snapshot files. */
  deleteSnapshot(ref: SnapshotRef): ResultAsync<void, LobsterError>;
}
```

### 3.2 Why This Shape

- **6 operations** map 1:1 to the 6 categories identified in section 2.2.
- `OverlayRef` and `SnapshotRef` are opaque strings — the caller doesn't know or care whether they're file paths, S3 keys, or Ceph volume names.
- `attachToChroot` / `detachFromChroot` encapsulate the hard-link-vs-bind-mount decision per backend.
- `persistSnapshot` / `restoreSnapshot` encapsulate the chroot-to-persistent-storage copy direction.
- The interface uses `ResultAsync<T, LobsterError>` to stay consistent with the codebase's railway-oriented error handling.

### 3.3 Factory Function

```typescript
// src/system/storage.ts

import type { LobsterdConfig } from "../types/index.js";
import { createLocalBackend } from "./storage-local.js";
// import { createJuiceFSBackend } from "./storage-juicefs.js";  // Phase 2

export function createStorageBackend(config: LobsterdConfig): StorageBackend {
  const backendType = config.overlay.backend ?? "local";
  switch (backendType) {
    case "local":
      return createLocalBackend(config.overlay);
    // case "juicefs":
    //   return createJuiceFSBackend(config.overlay);
    default:
      throw new Error(`Unknown storage backend: ${backendType}`);
  }
}
```

---

## 4. Phase 1: Extract Local Backend

This phase is a **zero-behavior-change refactor**. Every line of implementation already exists in the codebase; we're regrouping it behind the `StorageBackend` interface.

### 4.1 New File: `src/system/storage-local.ts`

```typescript
import { okAsync, type ResultAsync } from "neverthrow";
import type { LobsterError, OverlayConfig } from "../types/index.js";
import type { OverlayRef, SnapshotRef, StorageBackend } from "./storage.js";
import { exec } from "./exec.js";
import { SNAPSHOTS_DIR } from "../config/defaults.js";

export function createLocalBackend(overlayConfig: OverlayConfig): StorageBackend {
  return {
    createOverlay(name, sizeMb) {
      const path = `${overlayConfig.baseDir}/${name}.ext4`;
      return exec(["truncate", "-s", `${sizeMb}M`, path])
        .andThen(() => exec(["mkfs.ext4", "-F", "-q", path]))
        .map(() => path as OverlayRef)
        .mapErr((e) => ({
          ...e,
          code: "OVERLAY_CREATE_FAILED" as const,
          message: `Failed to create overlay at ${path}: ${e.message}`,
        }));
    },

    deleteOverlay(ref) {
      return exec(["rm", "-f", ref])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    },

    attachToChroot(ref, chrootRoot, uid) {
      // Same filesystem — hard-link works
      return exec(["ln", "-f", ref, `${chrootRoot}/overlay.ext4`])
        .andThen(() =>
          exec(["chown", `${uid}:${uid}`, `${chrootRoot}/overlay.ext4`]),
        )
        .map(() => undefined)
        .mapErr((e) => ({
          ...e,
          code: "JAILER_SETUP_FAILED" as const,
          message: `Failed to attach overlay to chroot: ${e.message}`,
        }));
    },

    detachFromChroot(_ref, _chrootRoot) {
      // No-op: hard link is removed when chroot is rm -rf'd
      return okAsync(undefined);
    },

    persistSnapshot(name, chrootRoot) {
      const dir = `${SNAPSHOTS_DIR}/${name}`;
      return exec(["mkdir", "-p", dir])
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${chrootRoot}/snapshot_file`,
            `${dir}/snapshot_file`,
          ]),
        )
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${chrootRoot}/mem_file`,
            `${dir}/mem_file`,
          ]),
        )
        .map(() => dir as SnapshotRef)
        .mapErr((e) => ({
          ...e,
          code: "SNAPSHOT_FAILED" as const,
          message: `Failed to persist snapshot for ${name}: ${e.message}`,
        }));
    },

    restoreSnapshot(ref, chrootRoot, uid) {
      return exec([
        "cp", "--sparse=always",
        `${ref}/snapshot_file`,
        `${chrootRoot}/snapshot_file`,
      ])
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${ref}/mem_file`,
            `${chrootRoot}/mem_file`,
          ]),
        )
        .andThen(() =>
          exec([
            "chown", `${uid}:${uid}`,
            `${chrootRoot}/snapshot_file`,
            `${chrootRoot}/mem_file`,
          ]),
        )
        .map(() => undefined)
        .mapErr((e) => ({
          ...e,
          code: "SNAPSHOT_FAILED" as const,
          message: `Failed to restore snapshot into chroot: ${e.message}`,
        }));
    },

    deleteSnapshot(ref) {
      return exec(["rm", "-rf", ref])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    },
  };
}
```

### 4.2 Changes to Existing Files

#### `src/types/index.ts`

Rename `overlayPath` to `overlayRef` on the Tenant interface, and `snapshotDir` to `snapshotRef` on SuspendInfo. These are now opaque references, not necessarily local paths.

```diff
 export interface Tenant {
   name: string;
   vmId: string;
   // ... unchanged fields ...
-  overlayPath: string;
+  overlayRef: string;
   socketPath: string;
   // ... unchanged fields ...
 }

 export interface SuspendInfo {
   suspendedAt: string;
-  snapshotDir: string;
+  snapshotRef: string;
   cronSchedules: CronScheduleInfo[];
   // ... unchanged fields ...
 }
```

#### `src/config/schema.ts`

Add `backend` field to overlay config schema:

```diff
 export const overlayConfigSchema = z.object({
   baseDir: z.string().min(1),
   defaultSizeMb: z.number().int().min(256),
   snapshotRetention: z.number().int().min(0),
+  backend: z.enum(["local", "juicefs"]).default("local"),
 });
```

#### `src/types/index.ts` (OverlayConfig)

```diff
 export interface OverlayConfig {
   baseDir: string;
   defaultSizeMb: number;
   snapshotRetention: number;
+  backend?: "local" | "juicefs";
 }
```

#### `src/system/jailer.ts`

Split `linkChrootFiles` into kernel/rootfs linking (stays here) and overlay attachment (moves to StorageBackend):

```diff
-/** Hard-link drive and kernel files into an existing jailer chroot. */
-export function linkChrootFiles(
-  chrootBaseDir: string,
-  vmId: string,
-  kernelPath: string,
-  rootfsPath: string,
-  overlayPath: string,
-  uid: number,
-): ResultAsync<void, LobsterError> {
-  const root = getChrootRoot(chrootBaseDir, vmId);
-  return exec(["ln", "-f", kernelPath, `${root}/vmlinux`])
-    .andThen(() => exec(["ln", "-f", rootfsPath, `${root}/rootfs.ext4`]))
-    .andThen(() => exec(["ln", "-f", overlayPath, `${root}/overlay.ext4`]))
-    .andThen(() => exec(["chown", `${uid}:${uid}`, `${root}/overlay.ext4`]))
-    .map(() => undefined)
-    .mapErr((e) => ({
-      ...e,
-      code: "JAILER_SETUP_FAILED" as const,
-      message: `Failed to set up jailer chroot files: ${e.message}`,
-    }));
-}
+/** Hard-link kernel and rootfs into an existing jailer chroot. */
+export function linkReadOnlyFiles(
+  chrootBaseDir: string,
+  vmId: string,
+  kernelPath: string,
+  rootfsPath: string,
+): ResultAsync<void, LobsterError> {
+  const root = getChrootRoot(chrootBaseDir, vmId);
+  return exec(["ln", "-f", kernelPath, `${root}/vmlinux`])
+    .andThen(() => exec(["ln", "-f", rootfsPath, `${root}/rootfs.ext4`]))
+    .map(() => undefined)
+    .mapErr((e) => ({
+      ...e,
+      code: "JAILER_SETUP_FAILED" as const,
+      message: `Failed to link read-only files into chroot: ${e.message}`,
+    }));
+}
```

#### `src/commands/spawn.ts`

Accept a `StorageBackend` (passed in or constructed from config). Replace inline overlay/snapshot operations:

```diff
 // At the top / function signature — receive or construct storage backend
+import { createStorageBackend, type StorageBackend } from "../system/storage.js";
+const storage = createStorageBackend(config);

 // Line ~109: overlay path construction
-const overlayPath = `${config.overlay.baseDir}/${name}.ext4`;
 // (removed — the backend decides the path/ref)

 // Line ~139: create overlay
-return image.createOverlay(overlayPath, config.overlay.defaultSizeMb);
+return storage.createOverlay(name, config.overlay.defaultSizeMb);

 // Line ~142: rollback
-undoStack.push(() => image.deleteOverlay(tenant.overlayPath));
+undoStack.push(() => storage.deleteOverlay(tenant.overlayRef));

 // Line ~252-259: link chroot files
-return jailer.linkChrootFiles(
-  config.jailer.chrootBaseDir, tenant.vmId,
-  config.firecracker.kernelPath, config.firecracker.rootfsPath,
-  tenant.overlayPath, tenant.jailUid,
-);
+return jailer.linkReadOnlyFiles(
+  config.jailer.chrootBaseDir, tenant.vmId,
+  config.firecracker.kernelPath, config.firecracker.rootfsPath,
+).andThen(() => {
+  const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
+  return storage.attachToChroot(tenant.overlayRef, chrootRoot, tenant.jailUid);
+});
```

#### `src/commands/evict.ts`

```diff
+import { createStorageBackend } from "../system/storage.js";
+const storage = createStorageBackend(config);

 // Line ~52: snapshot cleanup
-return exec(["rm", "-rf", tenant.suspendInfo.snapshotDir])
+return storage.deleteSnapshot(tenant.suspendInfo.snapshotRef)

 // Before chroot cleanup (~line 126) — add detach:
+const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
+return storage.detachFromChroot(tenant.overlayRef, chrootRoot)
+  .andThen(() => jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId));

 // Line ~133: delete overlay
-return image.deleteOverlay(tenant.overlayPath)
+return storage.deleteOverlay(tenant.overlayRef)
```

#### `src/commands/suspend.ts`

```diff
+import { createStorageBackend } from "../system/storage.js";
+const storage = createStorageBackend(config);

 // Lines ~174-195: snapshot copy-out (entire block replaced)
-progress("snapshot", `Copying snapshot to ${snapshotDir}`);
-const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
-return exec(["mkdir", "-p", snapshotDir])
-  .andThen(() => exec(["cp", "--sparse=always", `${chrootRoot}/snapshot_file`, `${snapshotDir}/snapshot_file`]))
-  .andThen(() => exec(["cp", "--sparse=always", `${chrootRoot}/mem_file`, `${snapshotDir}/mem_file`]));
+progress("snapshot", "Persisting snapshot");
+const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
+return storage.persistSnapshot(name, chrootRoot);

 // Before chroot cleanup — add detach:
+return storage.detachFromChroot(tenant.overlayRef, chrootRoot)
+  .andThen(() => jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId));

 // Line ~276: suspend info
-snapshotDir,
+snapshotRef,  // the ref returned from persistSnapshot
```

#### `src/commands/resume.ts`

```diff
+import { createStorageBackend } from "../system/storage.js";
+const storage = createStorageBackend(config);

 // Line ~52: get snapshot ref
-snapshotDir = found.suspendInfo.snapshotDir;
+snapshotRef = found.suspendInfo.snapshotRef;

 // Lines ~94-101: link chroot files
-return jailer.linkChrootFiles(
-  config.jailer.chrootBaseDir, tenant.vmId,
-  config.firecracker.kernelPath, config.firecracker.rootfsPath,
-  tenant.overlayPath, tenant.jailUid,
-);
+return jailer.linkReadOnlyFiles(
+  config.jailer.chrootBaseDir, tenant.vmId,
+  config.firecracker.kernelPath, config.firecracker.rootfsPath,
+).andThen(() => {
+  const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
+  return storage.attachToChroot(tenant.overlayRef, chrootRoot, tenant.jailUid);
+});

 // Lines ~110-131: snapshot restore (entire block replaced)
-return exec(["cp", "--sparse=always", `${snapshotDir}/snapshot_file`, `${chrootRoot}/snapshot_file`])
-  .andThen(...)
+return storage.restoreSnapshot(snapshotRef, chrootRoot, tenant.jailUid);

 // Line ~152: snapshot cleanup
-return exec(["rm", "-rf", snapshotDir])
+return storage.deleteSnapshot(snapshotRef)
```

#### `src/repair/vm.ts`

```diff
+import { createStorageBackend } from "../system/storage.js";
+const storage = createStorageBackend(config);

 // Lines ~69-76: link chroot files
-jailer.linkChrootFiles(
-  config.jailer.chrootBaseDir, tenant.vmId,
-  config.firecracker.kernelPath, config.firecracker.rootfsPath,
-  tenant.overlayPath, tenant.jailUid,
-)
+jailer.linkReadOnlyFiles(
+  config.jailer.chrootBaseDir, tenant.vmId,
+  config.firecracker.kernelPath, config.firecracker.rootfsPath,
+).andThen(() => {
+  const chrootRoot = jailer.getChrootRoot(config.jailer.chrootBaseDir, tenant.vmId);
+  return storage.attachToChroot(tenant.overlayRef, chrootRoot, tenant.jailUid);
+})
```

### 4.3 Files to Delete After Extraction

- `src/system/image.ts` — all 3 functions are now inside `storage-local.ts`. Remove entirely (check no other imports first — `resizeOverlay` is defined but never called).

### 4.4 Registry Migration

The registry JSON on disk has `overlayPath` and `snapshotDir` fields. For the local backend, the values are identical (they're still file paths). Two approaches:

**Option A (recommended): Keep the field names, update only the TypeScript types.** The JSON fields stay as `overlayPath` and `snapshotDir` in the registry file. The TypeScript Tenant interface renames them semantically. Add a registry migration later if/when needed.

**Option B: Rename in-place.** Write a one-time migration in `loadRegistry()` that renames the fields. More correct but adds complexity in Phase 1.

Recommend Option A for Phase 1. The Zod schema and serialization can alias the fields:

```typescript
// In schema, accept both names:
overlayRef: z.string().min(1),  // or keep overlayPath and alias in code
```

---

## 5. Phase 2: JuiceFS Backend

### 5.1 Prerequisites

On every lobsterd host:
- JuiceFS FUSE mount at a configurable path (e.g., `/mnt/juicefs`)
- Local NVMe cache partition (e.g., `/var/cache/juicefs`)
- JuiceFS metadata engine (Redis Sentinel, KeyDB, PostgreSQL, or TiKV)
- Object storage bucket (S3, R2, MinIO) for data chunks

JuiceFS mount command (run as systemd unit):
```bash
juicefs mount \
  redis://meta-host:6379/1 \
  /mnt/juicefs \
  --cache-dir /var/cache/juicefs \
  --cache-size 102400 \       # 100 GB local cache
  --writeback \               # async writes (faster, see durability notes)
  --max-uploads 20 \
  --buffer-size 300
```

### 5.2 Config Changes

```typescript
export interface OverlayConfig {
  baseDir: string;              // "/mnt/juicefs/overlays" for JuiceFS
  defaultSizeMb: number;
  snapshotRetention: number;
  backend?: "local" | "juicefs";
  juicefs?: {
    mountPoint: string;         // "/mnt/juicefs"
    snapshotsDir?: string;      // default: "{mountPoint}/snapshots"
  };
}
```

### 5.3 New File: `src/system/storage-juicefs.ts`

```typescript
import { okAsync, type ResultAsync } from "neverthrow";
import type { LobsterError, OverlayConfig } from "../types/index.js";
import type { OverlayRef, SnapshotRef, StorageBackend } from "./storage.js";
import { exec } from "./exec.js";

export function createJuiceFSBackend(overlayConfig: OverlayConfig): StorageBackend {
  const mountPoint = overlayConfig.juicefs?.mountPoint ?? "/mnt/juicefs";
  const overlaysDir = overlayConfig.baseDir;  // should be under mountPoint
  const snapshotsDir = overlayConfig.juicefs?.snapshotsDir ?? `${mountPoint}/snapshots`;

  return {
    createOverlay(name, sizeMb) {
      // POSIX-compatible: truncate + mkfs.ext4 work on JuiceFS FUSE mount
      const path = `${overlaysDir}/${name}.ext4`;
      return exec(["truncate", "-s", `${sizeMb}M`, path])
        .andThen(() => exec(["mkfs.ext4", "-F", "-q", path]))
        .map(() => path as OverlayRef)
        .mapErr((e) => ({
          ...e,
          code: "OVERLAY_CREATE_FAILED" as const,
          message: `Failed to create overlay on JuiceFS at ${path}: ${e.message}`,
        }));
    },

    deleteOverlay(ref) {
      return exec(["rm", "-f", ref])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    },

    attachToChroot(ref, chrootRoot, uid) {
      // Cross-filesystem: use bind mount
      // First, create an empty file as the mount target
      const target = `${chrootRoot}/overlay.ext4`;
      return exec(["touch", target])
        .andThen(() => exec(["mount", "--bind", ref, target]))
        .andThen(() => exec(["chown", `${uid}:${uid}`, target]))
        .map(() => undefined)
        .mapErr((e) => ({
          ...e,
          code: "JAILER_SETUP_FAILED" as const,
          message: `Failed to bind-mount overlay into chroot: ${e.message}`,
        }));
    },

    detachFromChroot(_ref, chrootRoot) {
      // MUST be called before cleanupChroot to avoid "device busy"
      const target = `${chrootRoot}/overlay.ext4`;
      return exec(["umount", target])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));  // soft-fail if not mounted
    },

    persistSnapshot(name, chrootRoot) {
      // Store on JuiceFS — accessible from any host
      const dir = `${snapshotsDir}/${name}`;
      return exec(["mkdir", "-p", dir])
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${chrootRoot}/snapshot_file`,
            `${dir}/snapshot_file`,
          ]),
        )
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${chrootRoot}/mem_file`,
            `${dir}/mem_file`,
          ]),
        )
        .map(() => dir as SnapshotRef)
        .mapErr((e) => ({
          ...e,
          code: "SNAPSHOT_FAILED" as const,
          message: `Failed to persist snapshot to JuiceFS for ${name}: ${e.message}`,
        }));
    },

    restoreSnapshot(ref, chrootRoot, uid) {
      // Pull from JuiceFS (may be cached or fetched from object store)
      return exec([
        "cp", "--sparse=always",
        `${ref}/snapshot_file`,
        `${chrootRoot}/snapshot_file`,
      ])
        .andThen(() =>
          exec([
            "cp", "--sparse=always",
            `${ref}/mem_file`,
            `${chrootRoot}/mem_file`,
          ]),
        )
        .andThen(() =>
          exec([
            "chown", `${uid}:${uid}`,
            `${chrootRoot}/snapshot_file`,
            `${chrootRoot}/mem_file`,
          ]),
        )
        .map(() => undefined)
        .mapErr((e) => ({
          ...e,
          code: "SNAPSHOT_FAILED" as const,
          message: `Failed to restore snapshot from JuiceFS: ${e.message}`,
        }));
    },

    deleteSnapshot(ref) {
      return exec(["rm", "-rf", ref])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    },
  };
}
```

### 5.4 Bind Mount vs. Copy Trade-off

**Bind mount** (recommended):
- `mount --bind /mnt/juicefs/overlays/alice.ext4 /var/lib/lobsterd/jailer/.../root/overlay.ext4`
- Firecracker writes go through to JuiceFS in real-time (via FUSE → local cache → async flush to object store)
- No data duplication
- Requires `detachFromChroot` (umount) before chroot cleanup
- If the JuiceFS mount goes down, Firecracker I/O hangs (FUSE stall)

**Copy** (safer, simpler):
- `cp --sparse=always` overlay from JuiceFS into local chroot on attach
- `cp --sparse=always` overlay from local chroot back to JuiceFS on detach
- Firecracker operates on local disk (fast, no FUSE dependency during runtime)
- Doubles disk usage temporarily (4GB local + 4GB on JuiceFS)
- Data on JuiceFS is stale until detach (suspend/evict)
- Better fault isolation

**Recommendation:** Start with bind mount. Fall back to copy if FUSE stability is a concern. The interface supports both — the switch is internal to the backend.

---

## 6. Fencing and Distributed Locking

When two hosts could potentially resume the same tenant, you need fencing to prevent split-brain (two VMs writing to the same overlay simultaneously).

### 6.1 The Problem

1. Host A is running tenant "alice"
2. Host A crashes (kernel panic, power loss)
3. Orchestrator detects Host A is gone
4. Host B starts resuming "alice" from JuiceFS snapshot
5. Host A comes back online — its old Firecracker process might still be alive

If both write to the same overlay on JuiceFS, data corruption is guaranteed.

### 6.2 Fencing Strategy

Add `acquireLock` / `releaseLock` to the storage interface:

```typescript
export interface StorageBackend {
  // ... existing methods ...

  /** Acquire an exclusive lock on a tenant's storage. Must succeed before attachToChroot. */
  acquireLock?(name: string, hostId: string, ttlMs: number): ResultAsync<void, LobsterError>;

  /** Release the lock. Called after detachFromChroot. */
  releaseLock?(name: string): ResultAsync<void, LobsterError>;
}
```

These are optional (local backend doesn't need them) and only relevant for distributed backends.

### 6.3 Implementation Options

**Option A: Redis lock (if using Redis for JuiceFS metadata)**
```bash
# Acquire: SET with NX and PX (expiry)
redis-cli SET "lobster:lock:alice" "host-b" NX PX 30000

# Release: DEL with Lua script (only if we hold it)
redis-cli EVAL "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 "lobster:lock:alice" "host-b"
```
- Natural fit if Redis is already running for JuiceFS metadata
- TTL-based: if the holding host crashes, lock expires automatically
- Requires a lock renewal loop (heartbeat) while the tenant is active

**Option B: JuiceFS flock**
```bash
# Use flock on a sentinel file on JuiceFS itself
flock -x -n /mnt/juicefs/locks/alice.lock -c "echo locked"
```
- No extra infrastructure
- Relies on JuiceFS's distributed lock semantics
- Less control over TTL (depends on FUSE session timeout)

**Option C: etcd lease**
- Most robust but adds another dependency
- Natural fit if you later move the registry to etcd

**Recommendation:** Start with Redis lock (Option A) since JuiceFS already requires Redis. Add lock acquisition to the spawn and resume flows, right before `attachToChroot`.

### 6.4 Integration Point

In spawn.ts and resume.ts, before attaching:

```typescript
// Acquire lock (distributed backends only)
if (storage.acquireLock) {
  await storage.acquireLock(name, HOST_ID, 30_000).match(
    () => { /* locked */ },
    (err) => { /* another host holds the lock — abort resume */ },
  );
}

// Then attach
await storage.attachToChroot(tenant.overlayRef, chrootRoot, tenant.jailUid);
```

In evict.ts and suspend.ts, after detaching:

```typescript
await storage.detachFromChroot(tenant.overlayRef, chrootRoot);
if (storage.releaseLock) {
  await storage.releaseLock(name);
}
```

---

## 7. Hard-Link to Bind Mount Migration

### 7.1 Current Flow (Local)

```
jailer spawns → creates chroot dir structure
linkChrootFiles() → ln -f overlay to chroot/overlay.ext4
Firecracker starts → reads/writes chroot/overlay.ext4
                     (which IS the overlay file, same inode)
cleanupChroot()   → rm -rf chroot dir
                     (overlay file survives — different dir entry, same inode)
```

### 7.2 New Flow (JuiceFS)

```
jailer spawns     → creates chroot dir structure
linkReadOnlyFiles → ln -f kernel, rootfs to chroot (same local FS, works)
attachToChroot()  → mount --bind juicefs_overlay → chroot/overlay.ext4
Firecracker starts → reads/writes chroot/overlay.ext4
                     (which is the bind-mounted JuiceFS file)
detachFromChroot() → umount chroot/overlay.ext4     ← NEW STEP
cleanupChroot()   → rm -rf chroot dir
```

### 7.3 Where to Add detachFromChroot Calls

There are exactly **4 places** where `cleanupChroot` is called and an overlay may be attached:

| File | Line | Context | Add detach before? |
|------|------|---------|--------------------|
| `spawn.ts` | ~202 | Pre-cleanup of stale chroot | No (stale, may not be mounted) |
| `spawn.ts` | ~242 | Rollback on spawn failure | **Yes** — overlay was just attached |
| `evict.ts` | ~127 | Eviction teardown | **Yes** — overlay is attached while VM runs |
| `suspend.ts` | ~212 | Post-suspend cleanup | **Yes** — overlay was attached while VM ran |
| `resume.ts` | ~59 | Pre-cleanup of stale chroot | No (stale from previous session) |

For the local backend, `detachFromChroot` is a no-op, so adding these calls everywhere is safe and has zero cost.

### 7.4 Firecracker Jailer Compatibility

The Firecracker jailer expects files to be in its chroot. It does **not** inspect whether they are hard links, bind mounts, or regular files. The jailer's seccomp filter allows `read`/`write`/`mmap` syscalls which work identically on bind-mounted files. No jailer changes needed.

One caveat: the jailer's `--chroot-base-dir` logic creates the directory structure and may set permissions. The bind mount target file must exist before `mount --bind` (hence the `touch` in `attachToChroot`). Verify that the jailer creates the `root/` directory before `linkReadOnlyFiles` / `attachToChroot` are called. Currently, the code does `Bun.sleep(800)` after jailer spawn to wait for this — that timing-based approach applies equally to bind mounts.

---

## 8. Cache Sizing

### 8.1 JuiceFS Cache Behavior

JuiceFS caches data blocks (default 4MB) on local disk:
- **Read cache:** Blocks read from object storage are cached locally. Subsequent reads hit SSD, not network.
- **Write-back cache** (if `--writeback`): Writes go to local cache first, flushed to object store asynchronously.
- **Eviction:** LRU. When cache disk is full, coldest blocks are evicted.

### 8.2 Sizing Formula

```
Required cache = (active tenants on host) × (hot data per tenant)
```

**Hot data per tenant** depends on the OpenClaw workload:
- Guest OS baseline: ~50-100 MB (Alpine + Bun + OpenClaw + SSH)
- OpenClaw active state: ~10-50 MB (config, cron state, small SQLite DBs)
- User application data: highly variable

Conservative estimate: **200 MB hot data per active tenant**.

| Active tenants/host | Recommended cache | NVMe size |
|---------------------|-------------------|-----------|
| 50 | 10 GB | 20 GB (2x headroom) |
| 200 | 40 GB | 80 GB |
| 500 | 100 GB | 200 GB |
| 1000 | 200 GB | 400 GB |

### 8.3 Suspended Tenant Optimization

Suspended tenants don't need cache. When a tenant suspends:
1. Its overlay data in cache becomes cold
2. JuiceFS LRU will evict it naturally as active tenants need space
3. No explicit cache invalidation needed

When a tenant resumes on a different host:
- First boot is slower (cache miss → fetch from object store)
- Typical cold-start penalty: 2-5 seconds for initial reads
- Subsequent access is fast (cache warms)

### 8.4 Configuration

Set cache size via JuiceFS mount option:
```bash
juicefs mount ... --cache-size 102400  # 100 GB in MB
```

Monitor cache effectiveness:
```bash
juicefs stats /mnt/juicefs  # shows hit rate, read/write throughput
```

### 8.5 Durability vs. Performance

**`--writeback` mode** (recommended for lobsterd):
- Writes go to local cache, flushed async
- If host crashes, unflushed writes are lost
- Risk window: up to `--flush-wait` seconds of data (default: 5 seconds)
- Acceptable for lobsterd: suspend already snapshots VM state; crash = lose last few seconds

**Sync mode** (if zero data loss required):
- Every write blocks until confirmed in object store
- Significantly slower (100-1000x write latency increase)
- Not recommended for interactive workloads

---

## 9. Implementation Phases with AI Prompts

### Phase 1: Extract StorageBackend Interface (Local Backend Only)

**Goal:** Refactor existing code to use the `StorageBackend` interface with a `LocalBackend` implementation. Zero behavior change. All existing functionality preserved.

**Verification:** `bun run ci` passes. Manual test: spawn, suspend, resume, evict all work identically.

---

#### Step 1.1: Create the interface and local backend files

**Prompt:**
```
Read these files in the lobsterd codebase:
- src/system/image.ts
- src/system/jailer.ts (especially linkChrootFiles)
- src/commands/suspend.ts (lines 174-195, the snapshot copy-out)
- src/commands/resume.ts (lines 110-131, the snapshot copy-in)
- src/config/defaults.ts (SNAPSHOTS_DIR constant)
- src/types/index.ts

Create two new files:

1. src/system/storage.ts — Contains:
   - Type aliases: OverlayRef = string, SnapshotRef = string
   - The StorageBackend interface with 7 methods: createOverlay, deleteOverlay,
     attachToChroot, detachFromChroot, persistSnapshot, restoreSnapshot, deleteSnapshot
   - A factory function createStorageBackend(config: LobsterdConfig) that returns
     createLocalBackend(config.overlay) (for now, only "local" backend)
   All methods return ResultAsync<T, LobsterError>.

2. src/system/storage-local.ts — Contains:
   - createLocalBackend(overlayConfig: OverlayConfig): StorageBackend
   - Implementation is a direct extraction of existing code:
     - createOverlay: from image.ts createOverlay (truncate + mkfs.ext4)
     - deleteOverlay: from image.ts deleteOverlay (rm -f)
     - attachToChroot: from jailer.ts linkChrootFiles lines 37-38 (ln -f overlay + chown)
     - detachFromChroot: no-op (okAsync(undefined))
     - persistSnapshot: from suspend.ts lines 179-195 (mkdir + 2x cp --sparse=always)
     - restoreSnapshot: from resume.ts lines 110-131 (2x cp --sparse=always + chown)
     - deleteSnapshot: rm -rf

Do NOT modify any existing files yet. Just create the two new files.
Run: bun run typecheck to verify the new files compile.
```

**Checkpoint:** `bun run typecheck` passes.

---

#### Step 1.2: Update types and config schema

**Prompt:**
```
Read these files:
- src/types/index.ts
- src/config/schema.ts

Make these changes:

1. In src/types/index.ts:
   - Rename Tenant.overlayPath to Tenant.overlayRef
   - Rename SuspendInfo.snapshotDir to SuspendInfo.snapshotRef
   - Add optional field to OverlayConfig: backend?: "local" | "juicefs"

2. In src/config/schema.ts:
   - In the tenant schema, rename overlayPath to overlayRef
   - In the suspendInfo schema, rename snapshotDir to snapshotRef
   - Add backend field to overlayConfigSchema: z.enum(["local", "juicefs"]).default("local")

Do NOT change any command files yet. Let the type errors guide the next step.
Run: bun run typecheck — expect errors in spawn.ts, evict.ts, suspend.ts, resume.ts,
     repair/vm.ts, snap.ts, and possibly UI components. List all error locations.
```

**Checkpoint:** Typecheck fails with a known set of errors (all `overlayPath` / `snapshotDir` references). This is expected and confirms the rename scope.

---

#### Step 1.3: Refactor jailer.ts

**Prompt:**
```
Read src/system/jailer.ts.

Rename linkChrootFiles to linkReadOnlyFiles and remove the overlay-related lines:
- Remove the overlayPath parameter
- Remove the ln -f for overlay.ext4 (line 37)
- Remove the chown for overlay.ext4 (line 38)
- Keep only the kernel (vmlinux) and rootfs (rootfs.ext4) hard links

The overlay attach is now handled by StorageBackend.attachToChroot, which callers
will invoke separately.

Run: bun run typecheck to see which callers need updating (they'll error on the
     old function name and parameter count).
```

**Checkpoint:** Typecheck shows errors at all `linkChrootFiles` call sites.

---

#### Step 1.4: Refactor spawn.ts

**Prompt:**
```
Read src/commands/spawn.ts fully.

Refactor to use StorageBackend:

1. Import createStorageBackend from ../system/storage.js
2. Construct the backend: const storage = createStorageBackend(config)
3. Replace overlay creation (~line 109, 139):
   - Remove: const overlayPath = `${config.overlay.baseDir}/${name}.ext4`
   - Replace image.createOverlay call with storage.createOverlay(name, sizeMb)
   - The returned OverlayRef goes into tenant.overlayRef (was overlayPath)
4. Replace rollback (~line 142):
   - image.deleteOverlay(tenant.overlayPath) → storage.deleteOverlay(tenant.overlayRef)
5. Replace jailer linking (~lines 252-259):
   - jailer.linkChrootFiles(...) →
     jailer.linkReadOnlyFiles(chrootBaseDir, vmId, kernelPath, rootfsPath)
       .andThen(() => storage.attachToChroot(tenant.overlayRef, chrootRoot, jailUid))
   - You'll need to compute chrootRoot using jailer.getChrootRoot()
6. Add detach in the rollback handler for the chroot step:
   - Before cleanupChroot in rollback, call storage.detachFromChroot(tenant.overlayRef, chrootRoot)
7. Fix all remaining overlayPath → overlayRef references

Remove the import of image.ts if no longer used.
Run: bun run typecheck
```

**Checkpoint:** `bun run typecheck` passes for spawn.ts.

---

#### Step 1.5: Refactor evict.ts

**Prompt:**
```
Read src/commands/evict.ts fully.

Refactor to use StorageBackend:

1. Import createStorageBackend
2. Construct the backend from config
3. Replace snapshot cleanup (~line 52):
   - exec(["rm", "-rf", tenant.suspendInfo.snapshotDir])
   → storage.deleteSnapshot(tenant.suspendInfo.snapshotRef)
4. Add detach before chroot cleanup (~line 126):
   - Compute chrootRoot
   - Call storage.detachFromChroot(tenant.overlayRef, chrootRoot)
     before jailer.cleanupChroot()
5. Replace overlay deletion (~line 133):
   - image.deleteOverlay(tenant.overlayPath)
   → storage.deleteOverlay(tenant.overlayRef)

Remove image.ts import if present.
Run: bun run typecheck
```

**Checkpoint:** `bun run typecheck` passes for evict.ts.

---

#### Step 1.6: Refactor suspend.ts

**Prompt:**
```
Read src/commands/suspend.ts fully.

Refactor to use StorageBackend:

1. Import createStorageBackend
2. Construct the backend from config
3. Replace the entire snapshot copy-out block (~lines 174-195):
   - Remove: snapshotDir variable, mkdir, two cp commands
   - Replace with: storage.persistSnapshot(name, chrootRoot)
   - Store the returned SnapshotRef
4. Add detach before chroot cleanup (~line 212):
   - Call storage.detachFromChroot(tenant.overlayRef, chrootRoot)
     before jailer.cleanupChroot()
5. In the SuspendInfo construction (~line 276):
   - snapshotDir → snapshotRef (use the ref from persistSnapshot)
6. Remove SNAPSHOTS_DIR import if no longer used here

Run: bun run typecheck
```

**Checkpoint:** `bun run typecheck` passes for suspend.ts.

---

#### Step 1.7: Refactor resume.ts

**Prompt:**
```
Read src/commands/resume.ts fully.

Refactor to use StorageBackend:

1. Import createStorageBackend
2. Construct the backend from config
3. Replace snapshot dir retrieval (~line 52):
   - snapshotDir → snapshotRef from suspendInfo.snapshotRef
4. Replace chroot file linking (~lines 94-101):
   - jailer.linkChrootFiles(...) →
     jailer.linkReadOnlyFiles(...) then storage.attachToChroot(...)
5. Replace entire snapshot copy-in block (~lines 110-131):
   - Remove the two cp commands and the chown
   - Replace with: storage.restoreSnapshot(snapshotRef, chrootRoot, jailUid)
6. Replace snapshot cleanup (~line 152):
   - exec(["rm", "-rf", snapshotDir]) → storage.deleteSnapshot(snapshotRef)
7. Update registry fields: overlayPath → overlayRef, snapshotDir → snapshotRef

Run: bun run typecheck
```

**Checkpoint:** `bun run typecheck` passes for resume.ts.

---

#### Step 1.8: Refactor repair/vm.ts and snap.ts

**Prompt:**
```
Read src/repair/vm.ts and src/commands/snap.ts fully.

For repair/vm.ts:
1. Import createStorageBackend
2. Replace jailer.linkChrootFiles with linkReadOnlyFiles + storage.attachToChroot
3. Fix overlayPath → overlayRef

For snap.ts:
1. The snap command reads tenant.overlayPath (now overlayRef) and copies it.
   Since overlayRef for the local backend IS still a file path, just rename
   the variable. The cp command works the same.
2. Fix overlayPath → overlayRef

Run: bun run typecheck
```

**Checkpoint:** `bun run typecheck` passes.

---

#### Step 1.9: Fix remaining references and clean up

**Prompt:**
```
Search the entire codebase for any remaining references to:
- overlayPath (should be overlayRef everywhere except possibly UI display strings)
- snapshotDir (should be snapshotRef everywhere except possibly UI display strings)
- linkChrootFiles (should be linkReadOnlyFiles everywhere)
- image.createOverlay, image.deleteOverlay, image.resizeOverlay

Fix all remaining references.

Check if src/system/image.ts is still imported anywhere. If not, delete it.

Also check UI components in src/ui/ that may display overlayPath — update those
to overlayRef.

Run: bun run ci (full CI: format + lint + typecheck)
```

**Checkpoint:** `bun run ci` passes with zero errors. This completes Phase 1.

---

#### Step 1.10: Verify (manual)

```
On a lobsterd host:
1. lobsterd init (if not already initialized — config should pick up backend: "local" default)
2. lobsterd spawn test-tenant
3. Verify VM is running, overlay exists at expected path
4. lobsterd suspend test-tenant (if watchdog-managed) or test snap
5. lobsterd resume test-tenant (or lobsterd spawn again after evict)
6. lobsterd evict test-tenant
7. Verify all files cleaned up

The behavior should be identical to before the refactor.
```

---

### Phase 2: JuiceFS Backend

**Goal:** Implement the JuiceFS storage backend. Requires a JuiceFS mount on the host.

**Prerequisites:** Phase 1 complete. JuiceFS mounted on a test host.

---

#### Step 2.1: Create the JuiceFS backend

**Prompt:**
```
Read:
- src/system/storage.ts (the interface)
- src/system/storage-local.ts (reference implementation)
- src/types/index.ts (OverlayConfig)
- src/config/schema.ts (overlayConfigSchema)

Create src/system/storage-juicefs.ts implementing StorageBackend:

- createOverlay: same as local (truncate + mkfs.ext4 work on FUSE mount)
- deleteOverlay: same as local (rm -f)
- attachToChroot: use bind mount (touch target file, mount --bind ref target, chown)
- detachFromChroot: umount the target, soft-fail if not mounted
- persistSnapshot: same as local but dir is under juicefs snapshotsDir
- restoreSnapshot: same as local (cp from juicefs → local chroot)
- deleteSnapshot: same as local (rm -rf)

Read the config to get:
- overlayConfig.juicefs.mountPoint (default "/mnt/juicefs")
- overlayConfig.juicefs.snapshotsDir (default "{mountPoint}/snapshots")
- overlayConfig.baseDir (should be "{mountPoint}/overlays")

Update the factory in storage.ts to handle backend: "juicefs".

Update src/config/schema.ts to add the juicefs sub-schema:
  juicefs: z.object({
    mountPoint: z.string().min(1),
    snapshotsDir: z.string().min(1).optional(),
  }).optional()

Update src/types/index.ts OverlayConfig with the juicefs field.

Run: bun run ci
```

**Checkpoint:** `bun run ci` passes.

---

#### Step 2.2: Add JuiceFS health check

**Prompt:**
```
Read src/checks/ to understand the health check pattern.

Add a new check: src/checks/juicefs.ts
- Verify the JuiceFS mount point is mounted (check /proc/mounts or run mountpoint -q)
- Verify the overlays directory exists and is writable (touch a sentinel file, rm it)
- Return HealthCheckResult with status ok/failed

Register this check in the watchdog for JuiceFS backend only.

Run: bun run ci
```

**Checkpoint:** `bun run ci` passes. Health check reports JuiceFS mount status.

---

#### Step 2.3: Add fencing (optional, for multi-host)

**Prompt:**
```
Read:
- src/system/storage.ts (StorageBackend interface)
- src/system/storage-juicefs.ts
- src/commands/spawn.ts (where attachToChroot is called)
- src/commands/resume.ts (where attachToChroot is called)

Add optional fencing methods to StorageBackend:
- acquireLock(name: string, hostId: string, ttlMs: number): ResultAsync<void, LobsterError>
- releaseLock(name: string): ResultAsync<void, LobsterError>

These are optional (not all backends need them).

In the JuiceFS backend, implement fencing using a Redis lock:
- Config adds: juicefs.redisUrl (same Redis used for JuiceFS metadata)
- acquireLock: SET key NX PX ttl via redis client
- releaseLock: DEL with ownership check via Lua script
- If lock acquisition fails, return a LOCK_FAILED error

In spawn.ts and resume.ts, before attachToChroot:
  if (storage.acquireLock) {
    const result = await storage.acquireLock(name, hostId, 30000);
    if (result.isErr()) return err(result.error);
  }

In evict.ts and suspend.ts, after detachFromChroot:
  if (storage.releaseLock) {
    await storage.releaseLock(name);  // best-effort
  }

Add a lock renewal mechanism: while a tenant is active, periodically
refresh the lock TTL (e.g., every ttl/3 ms). This could be a simple
setInterval in the spawn flow that's cleared on evict/suspend.

The hostId can be derived from hostname or a UUID persisted in
/etc/lobsterd/host-id.

Run: bun run ci
```

**Checkpoint:** `bun run ci` passes. Fencing is wired in but only activates for JuiceFS backend.

---

#### Step 2.4: Verify (manual, requires JuiceFS host)

```
On a host with JuiceFS mounted at /mnt/juicefs:

1. Update /etc/lobsterd/config.json:
   {
     "overlay": {
       "baseDir": "/mnt/juicefs/overlays",
       "defaultSizeMb": 4096,
       "snapshotRetention": 7,
       "backend": "juicefs",
       "juicefs": {
         "mountPoint": "/mnt/juicefs"
       }
     }
   }

2. mkdir -p /mnt/juicefs/overlays /mnt/juicefs/snapshots

3. lobsterd spawn test-jfs
   - Verify overlay created at /mnt/juicefs/overlays/test-jfs.ext4
   - Verify bind mount: mountpoint -q /var/lib/lobsterd/jailer/.../root/overlay.ext4
   - Verify VM boots and agent responds

4. lobsterd suspend test-jfs (or trigger via watchdog idle)
   - Verify snapshot at /mnt/juicefs/snapshots/test-jfs/
   - Verify bind mount is gone (umounted)

5. lobsterd resume test-jfs
   - Verify snapshot restored, VM boots, data persisted

6. lobsterd evict test-jfs
   - Verify overlay deleted from JuiceFS
   - Verify no stale bind mounts

Cross-host test (requires two hosts with same JuiceFS mount):
7. On Host A: lobsterd spawn cross-test
8. On Host A: lobsterd suspend cross-test
9. On Host B: manually add tenant to registry, lobsterd resume cross-test
   - Verify VM boots on Host B with Host A's data
```

---

### Phase Summary

| Phase | Steps | New Files | Modified Files | Risk |
|-------|-------|-----------|----------------|------|
| **1: Extract** | 1.1-1.10 | `storage.ts`, `storage-local.ts` | `jailer.ts`, `spawn.ts`, `evict.ts`, `suspend.ts`, `resume.ts`, `repair/vm.ts`, `snap.ts`, `types/index.ts`, `config/schema.ts` | Low (refactor only) |
| **2: JuiceFS** | 2.1-2.4 | `storage-juicefs.ts`, `checks/juicefs.ts` | `storage.ts` (factory), `config/schema.ts`, `types/index.ts` | Medium (new behavior) |

Phase 1 can be done and shipped independently. Phase 2 requires JuiceFS infrastructure but is additive — the local backend remains the default.

---

## Appendix A: File Reference

All files that will be created or modified:

```
NEW FILES:
  src/system/storage.ts           — Interface + factory
  src/system/storage-local.ts     — Local backend (extracted from existing code)
  src/system/storage-juicefs.ts   — JuiceFS backend (Phase 2)
  src/checks/juicefs.ts           — JuiceFS health check (Phase 2)

MODIFIED FILES:
  src/system/jailer.ts            — linkChrootFiles → linkReadOnlyFiles (remove overlay)
  src/commands/spawn.ts           — Use StorageBackend for overlay + chroot attach
  src/commands/evict.ts           — Use StorageBackend for cleanup
  src/commands/suspend.ts         — Use StorageBackend for snapshot persist
  src/commands/resume.ts          — Use StorageBackend for snapshot restore
  src/repair/vm.ts                — Use StorageBackend for chroot attach
  src/commands/snap.ts            — Rename overlayPath → overlayRef
  src/types/index.ts              — Rename fields, add OverlayConfig.backend
  src/config/schema.ts            — Add backend + juicefs schema fields

DELETED FILES:
  src/system/image.ts             — Replaced by storage-local.ts
```

## Appendix B: Data Flow Diagrams

### Local Backend (Current Behavior, Preserved)

```
spawn:
  storage.createOverlay("alice", 4096)
    → truncate + mkfs.ext4 → /var/lib/lobsterd/overlays/alice.ext4
    → returns "/var/lib/lobsterd/overlays/alice.ext4" as OverlayRef

  jailer.linkReadOnlyFiles(...)
    → ln -f vmlinux, rootfs.ext4 into chroot

  storage.attachToChroot(ref, chrootRoot, uid)
    → ln -f overlay into chroot + chown

  [Firecracker runs, writes to overlay via hard link]

suspend:
  [Firecracker paused, snapshot created in chroot]

  storage.persistSnapshot("alice", chrootRoot)
    → cp --sparse=always snapshot_file, mem_file → /var/lib/lobsterd/snapshots/alice/
    → returns "/var/lib/lobsterd/snapshots/alice" as SnapshotRef

  storage.detachFromChroot(ref, chrootRoot)
    → no-op (local backend)

  jailer.cleanupChroot(...)
    → rm -rf chroot

resume:
  jailer.linkReadOnlyFiles(...)
  storage.attachToChroot(ref, chrootRoot, uid)
    → ln -f overlay into new chroot

  storage.restoreSnapshot(snapshotRef, chrootRoot, uid)
    → cp --sparse=always from snapshots/ into chroot + chown

  [Firecracker loads snapshot, VM resumes]

  storage.deleteSnapshot(snapshotRef)
    → rm -rf /var/lib/lobsterd/snapshots/alice/

evict:
  storage.deleteSnapshot(snapshotRef)  [if suspended]
  storage.detachFromChroot(ref, chrootRoot)  → no-op
  jailer.cleanupChroot(...)
  storage.deleteOverlay(ref)
    → rm -f /var/lib/lobsterd/overlays/alice.ext4
```

### JuiceFS Backend (New)

```
spawn:
  storage.createOverlay("alice", 4096)
    → truncate + mkfs.ext4 → /mnt/juicefs/overlays/alice.ext4
    → returns "/mnt/juicefs/overlays/alice.ext4" as OverlayRef

  jailer.linkReadOnlyFiles(...)
    → ln -f vmlinux, rootfs.ext4 into chroot (local FS, hard-link works)

  storage.acquireLock("alice", "host-a", 30000)  [if fencing enabled]
    → Redis SET lobster:lock:alice host-a NX PX 30000

  storage.attachToChroot(ref, chrootRoot, uid)
    → touch chrootRoot/overlay.ext4
    → mount --bind /mnt/juicefs/overlays/alice.ext4 chrootRoot/overlay.ext4
    → chown uid:uid chrootRoot/overlay.ext4

  [Firecracker runs, writes go through bind mount → JuiceFS FUSE → local cache → S3]

suspend:
  [Firecracker paused, snapshot created in chroot]

  storage.persistSnapshot("alice", chrootRoot)
    → cp --sparse=always snapshot_file, mem_file → /mnt/juicefs/snapshots/alice/
    → returns "/mnt/juicefs/snapshots/alice" as SnapshotRef

  storage.detachFromChroot(ref, chrootRoot)
    → umount chrootRoot/overlay.ext4

  storage.releaseLock("alice")  [if fencing enabled]
    → Redis DEL lobster:lock:alice (with ownership check)

  jailer.cleanupChroot(...)
    → rm -rf chroot

resume (POSSIBLY ON A DIFFERENT HOST):
  jailer.linkReadOnlyFiles(...)

  storage.acquireLock("alice", "host-b", 30000)  [if fencing enabled]

  storage.attachToChroot(ref, chrootRoot, uid)
    → mount --bind (JuiceFS fetches from S3 if not in local cache)

  storage.restoreSnapshot(snapshotRef, chrootRoot, uid)
    → cp from JuiceFS snapshots/ into local chroot (may hit cache or S3)

  [Firecracker loads snapshot, VM resumes with all data from Host A]

  storage.deleteSnapshot(snapshotRef)
    → rm -rf /mnt/juicefs/snapshots/alice/
```
