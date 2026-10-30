import { randomUUID } from "node:crypto";
import { open, readFile, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConnectorHost,
  ConnectorInstallation,
  ConnectorStopContext,
} from "@regenic/connector-contract";
import { ensureProfileDirectory, validateProfileId } from "./profile.js";
import { SystemKeyring, type TelegramKeyring } from "./keyring.js";
import {
  openTdlibClient,
  type TdlibClient,
} from "./tdlib-session.js";

export interface TelegramRuntimeOptions {
  keyring?: TelegramKeyring;
  openClient?: typeof openTdlibClient;
}

interface InstallationActivation {
  profileId: string;
  controller: AbortController;
  clients: Set<TdlibClient>;
  operations: Set<Promise<unknown>>;
  open: boolean;
  stopPromise?: Promise<void>;
  stopFailed?: boolean;
}

export class TelegramRuntime {
  private readonly activations = new Map<string, InstallationActivation>();
  private readonly keyring: TelegramKeyring;
  private readonly openClient: typeof openTdlibClient;
  private readonly profileQueues = new Map<string, Promise<void>>();

  constructor(options: TelegramRuntimeOptions = {}) {
    this.keyring = options.keyring ?? new SystemKeyring();
    this.openClient = options.openClient ?? openTdlibClient;
  }

  async startInstallation(installation: ConnectorInstallation): Promise<void> {
    const profileId = validateProfileId(configString(installation, "profile_id"));
    const current = this.activations.get(installation.id);
    if (current?.open) {
      if (current.profileId !== profileId) {
        throw new Error("Telegram profile changed without stopping the previous activation");
      }
      return;
    }
    if (current) {
      if (current.stopPromise) {
        await current.stopPromise;
      } else if (current.stopFailed) {
        throw new Error("Telegram installation must finish its previous stop before restart");
      }
    }
    this.activations.set(installation.id, {
      profileId,
      controller: new AbortController(),
      clients: new Set(),
      operations: new Set(),
      open: true,
    });
  }

  async stopInstallation(
    installation: ConnectorInstallation,
    _host: ConnectorHost,
    context: ConnectorStopContext,
  ): Promise<void> {
    const activation = this.activations.get(installation.id);
    if (!activation) {
      return;
    }
    if (activation.stopPromise) {
      return activation.stopPromise;
    }
    activation.open = false;
    activation.controller.abort(new Error("Telegram installation stopped"));
    activation.stopPromise = (async () => {
      const clients = [...activation.clients];
      const stopResults = await Promise.allSettled(
        clients.map((client) => client.close(context.signal)),
      );
      await Promise.allSettled([...activation.operations]);
      const failure = stopResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure || activation.clients.size > 0) {
        throw new Error("Telegram installation did not stop cleanly", {
          cause: failure?.reason,
        });
      }
      this.activations.delete(installation.id);
    })();
    try {
      await activation.stopPromise;
    } catch (error) {
      delete activation.stopPromise;
      activation.stopFailed = true;
      throw error;
    }
  }

  async withClient<T>(
    installation: ConnectorInstallation,
    operation: (client: TdlibClient, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const activation = this.requireActivation(installation.id);
    const signal = callerSignal
      ? AbortSignal.any([activation.controller.signal, callerSignal])
      : activation.controller.signal;
    const profileId = activation.profileId;
    const task = this.withProfileQueue(profileId, async () => {
      if (!activation.open || signal.aborted) {
        throw new Error("Telegram installation activation is stopped");
      }
      const directory = await ensureProfileDirectory(profileId);
      const release = await acquireProfileLock(join(directory, ".client.lock"));
      let client: TdlibClient | undefined;
      try {
        if (!activation.open || signal.aborted) {
          throw new Error("Telegram installation activation is stopped");
        }
        client = await this.openClient({
          profileId,
          keyring: this.keyring,
          signal,
        });
        activation.clients.add(client);
        await client.waitUntilReady(signal);
        return await operation(client, signal);
      } finally {
        try {
          if (client) {
            await client.close();
            activation.clients.delete(client);
          }
        } finally {
          await release();
        }
      }
    });
    activation.operations.add(task);
    try {
      return await task;
    } finally {
      activation.operations.delete(task);
    }
  }

  private requireActivation(installationId: string): InstallationActivation {
    const activation = this.activations.get(installationId);
    if (!activation?.open) {
      throw new Error("Telegram installation is not active");
    }
    return activation;
  }

  private async withProfileQueue<T>(
    profileId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.profileQueues.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.profileQueues.set(profileId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.profileQueues.get(profileId) === current) {
        this.profileQueues.delete(profileId);
      }
    }
  }
}

function configString(
  installation: ConnectorInstallation,
  key: string,
): string {
  const value = installation.config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Telegram installation is missing ${key}`);
  }
  return value.trim();
}

async function acquireProfileLock(path: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
      return async () => {
        await handle.close();
        const owner = await readLock(path);
        if (owner?.token === token) {
          await rm(path);
        }
      };
    } catch (error) {
      if (!isExistsError(error)) {
        throw error;
      }
      const owner = await readLock(path);
      if (!owner) {
        throw new Error("Telegram profile lock is invalid; refusing to remove it automatically");
      }
      if (isProcessAlive(owner.pid)) {
        throw new Error("Telegram profile is already active in another local process");
      }
      await recoverStaleProfileLock(path, owner.token);
    }
  }
  throw new Error("Could not acquire Telegram profile lock");
}

async function readLock(path: string): Promise<{ pid: number; token: string } | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("pid" in value) ||
    !("token" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string"
  ) {
    return undefined;
  }
  return { pid: value.pid, token: value.token };
}

async function recoverStaleProfileLock(path: string, staleToken: string): Promise<void> {
  const recoveryPath = `${path}.recovery`;
  let recoveryHandle: FileHandle;
  try {
    recoveryHandle = await open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (isExistsError(error)) {
      throw new Error(
        "Telegram profile lock recovery is already in progress or needs manual cleanup",
      );
    }
    throw error;
  }
  try {
    const current = await readLock(path);
    if (!current) {
      throw new Error("Telegram profile lock changed during stale-lock recovery");
    }
    if (current.token !== staleToken || isProcessAlive(current.pid)) {
      throw new Error("Telegram profile became active during stale-lock recovery");
    }
    await rm(path);
  } finally {
    await recoveryHandle.close();
    await rm(recoveryPath, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

function isExistsError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
