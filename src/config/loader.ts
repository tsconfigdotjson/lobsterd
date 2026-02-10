import { ok, err, ResultAsync } from 'neverthrow';
import type { LobsterdConfig, TenantRegistry, LobsterError } from '../types/index.js';
import { lobsterdConfigSchema, tenantRegistrySchema } from './schema.js';
import { CONFIG_PATH, REGISTRY_PATH, DEFAULT_CONFIG, EMPTY_REGISTRY } from './defaults.js';

function readJsonFile<T>(path: string): ResultAsync<T | null, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return await file.json() as T;
    })(),
    (e) => ({ code: 'CONFIG_NOT_FOUND' as const, message: `Failed to read ${path}`, cause: e }),
  );
}

function writeJsonFileAtomic(path: string, data: unknown): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const tmpPath = `${path}.tmp.${process.pid}`;
      await Bun.write(tmpPath, JSON.stringify(data, null, 2) + '\n');
      const proc = Bun.spawn(['mv', tmpPath, path]);
      await proc.exited;
      if (proc.exitCode !== 0) {
        throw new Error(`mv failed with exit code ${proc.exitCode}`);
      }
    })(),
    (e) => ({ code: 'EXEC_FAILED' as const, message: `Failed to write ${path}`, cause: e }),
  );
}

export function loadConfig(): ResultAsync<LobsterdConfig, LobsterError> {
  return readJsonFile<LobsterdConfig>(CONFIG_PATH).andThen((data) => {
    if (data === null) {
      return ok(DEFAULT_CONFIG);
    }
    const parsed = lobsterdConfigSchema.safeParse(data);
    if (!parsed.success) {
      return err({
        code: 'CONFIG_INVALID' as const,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    return ok(parsed.data as LobsterdConfig);
  });
}

export function saveConfig(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return writeJsonFileAtomic(CONFIG_PATH, config);
}

export function loadRegistry(): ResultAsync<TenantRegistry, LobsterError> {
  return readJsonFile<TenantRegistry>(REGISTRY_PATH).andThen((data) => {
    if (data === null) {
      return ok(EMPTY_REGISTRY);
    }
    const parsed = tenantRegistrySchema.safeParse(data);
    if (!parsed.success) {
      return err({
        code: 'CONFIG_INVALID' as const,
        message: `Invalid registry: ${parsed.error.message}`,
      });
    }
    return ok(parsed.data as TenantRegistry);
  });
}

export function saveRegistry(registry: TenantRegistry): ResultAsync<void, LobsterError> {
  return writeJsonFileAtomic(REGISTRY_PATH, registry);
}
