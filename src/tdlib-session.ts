import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { access, constants } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ensureProfileDirectory,
  validateProfileId,
} from "./profile.js";
import {
  assertApiCredentials,
  assertDatabaseKey,
  getOrCreateDatabaseKey,
  type TelegramKeyring,
} from "./keyring.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 8_000;
const WORKER_PATH = fileURLToPath(new URL("./tdlib-worker.js", import.meta.url));
const POST_PARAMETER_AUTH_STATES = [
  "authorizationStateWaitPhoneNumber",
  "authorizationStateWaitPremiumPurchase",
  "authorizationStateWaitEmailAddress",
  "authorizationStateWaitEmailCode",
  "authorizationStateWaitCode",
  "authorizationStateWaitOtherDeviceConfirmation",
  "authorizationStateWaitRegistration",
  "authorizationStateWaitPassword",
  "authorizationStateReady",
  "authorizationStateLoggingOut",
  "authorizationStateClosing",
  "authorizationStateClosed",
] as const;

export type AuthorizationState =
  | "authorizationStateWaitTdlibParameters"
  | "authorizationStateWaitPhoneNumber"
  | "authorizationStateWaitCode"
  | "authorizationStateWaitPassword"
  | "authorizationStateReady"
  | "authorizationStateClosed"
  | string;

export interface TdlibChat {
  id: number;
  title: string;
  kind: string;
}

export interface TdlibSendUpdate {
  temporaryId: number;
  messageId: number;
}

export interface TdlibFailureUpdate extends TdlibSendUpdate {
  errorCode: number;
}

export interface TdlibClient {
  readonly authorizationState: AuthorizationState | undefined;
  readonly chats: ReadonlyMap<number, TdlibChat>;
  waitForState(
    states: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<string>;
  waitUntilReady(signal?: AbortSignal): Promise<void>;
  request<T extends Record<string, unknown>>(
    type: string,
    parameters?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  waitForSendUpdate(
    temporaryId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TdlibSendUpdate>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface OpenTdlibClientOptions {
  profileId: string;
  keyring: TelegramKeyring;
  nativeLibrary?: string;
  signal?: AbortSignal;
}

export async function resolveTdlibLibrary(
  override = process.env.REGENIC_TDLIB_LIBRARY,
): Promise<string> {
  const candidates = [
    override,
    resolve(dirname(WORKER_PATH), "../.local/tdlib/libtdjson.dylib"),
    "/opt/homebrew/lib/libtdjson.dylib",
    "/usr/local/lib/libtdjson.dylib",
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return resolve(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("TDLib JSON library not found; run `npm run tdlib:build`");
}

export async function openTdlibClient(
  options: OpenTdlibClientOptions,
): Promise<TdlibProcessSession> {
  const profileId = validateProfileId(options.profileId);
  const apiCredentials = assertApiCredentials(
    await options.keyring.read(profileId, "api-id"),
    await options.keyring.read(profileId, "api-hash"),
  );
  const databaseKey = await getOrCreateDatabaseKey(options.keyring, profileId);
  assertDatabaseKey(databaseKey);
  const directory = await ensureProfileDirectory(profileId);
  const nativeLibrary = options.nativeLibrary ?? (await resolveTdlibLibrary());
  const session = new TdlibProcessSession({
    nativeLibrary,
    apiId: apiCredentials.apiId,
    apiHash: apiCredentials.apiHash,
    databaseKey,
    databaseDirectory: join(directory, "database"),
    filesDirectory: join(directory, "files"),
    homeDirectory: process.env.HOME ?? "",
    path: process.env.PATH ?? "/usr/bin:/bin",
  });
  try {
    await session.initialize(options.signal);
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

interface WorkerConfig {
  nativeLibrary: string;
  apiId: number;
  apiHash: string;
  databaseKey: string;
  databaseDirectory: string;
  filesDirectory: string;
  homeDirectory: string;
  path: string;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface StateWaiter {
  states: Set<string>;
  resolve(state: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

type SendOutcome =
  | { value: TdlibSendUpdate; error?: never }
  | { value?: never; error: Error };

export class TdlibProcessSession implements TdlibClient {
  private readonly child;
  private readonly decoder = new StringDecoder("utf8");
  private readonly requests = new Map<string, PendingRequest>();
  private readonly stateWaiters = new Set<StateWaiter>();
  private readonly sendWaiters = new Map<
    number,
    { resolve(value: TdlibSendUpdate): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly sendOutcomes = new Map<number, SendOutcome>();
  private readonly chatMap = new Map<number, TdlibChat>();
  private readonly exitPromise: Promise<void>;
  private readonly exitResolve!: () => void;
  private stdoutBuffer = "";
  private authState?: string;
  private closePromise?: Promise<void>;
  private initialized = false;
  private closed = false;

  constructor(private readonly config: WorkerConfig) {
    let resolveExit!: () => void;
    this.exitPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveExit = resolvePromise;
    });
    this.exitResolve = resolveExit;
    void this.exitPromise.catch(() => undefined);
    this.child = spawn(process.execPath, [WORKER_PATH], {
      cwd: dirname(config.databaseDirectory),
      env: {
        HOME: config.homeDirectory,
        PATH: config.path,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("error", () => this.fail(new Error("TDLib worker could not start")));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitResolve();
      if (code !== 0) {
        this.rejectPending(
          new Error(`TDLib worker exited unexpectedly${signal ? ` (${signal})` : ""}`),
        );
      }
      this.rejectPending(new Error("TDLib worker closed before completing the operation"));
    });
  }

  get authorizationState(): AuthorizationState | undefined {
    return this.authState;
  }

  get chats(): ReadonlyMap<number, TdlibChat> {
    return this.chatMap;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    this.write({
      type: "init",
      nativeLibrary: this.config.nativeLibrary,
      apiId: this.config.apiId,
      apiHash: this.config.apiHash,
      databaseKey: this.config.databaseKey,
      databaseDirectory: this.config.databaseDirectory,
      filesDirectory: this.config.filesDirectory,
    });
    await this.waitForState(
      [
        "authorizationStateWaitTdlibParameters",
        ...POST_PARAMETER_AUTH_STATES,
      ],
      START_TIMEOUT_MS,
      signal,
    );
    this.initialized = true;
  }

  async waitForState(
    states: readonly string[],
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.authState && states.includes(this.authState)) {
      return this.authState;
    }
    if (this.closed) {
      throw new Error("TDLib worker closed before reaching the requested authorization state");
    }
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const waiter: StateWaiter = {
        states: new Set(states),
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: setTimeout(() => {
          this.stateWaiters.delete(waiter);
          rejectPromise(new Error("Timed out waiting for Telegram authorization state"));
          signal?.removeEventListener("abort", waiter.abort!);
        }, timeoutMs),
        ...(signal ? { signal } : {}),
      };
      waiter.timer.unref();
      waiter.abort = () => {
        clearTimeout(waiter.timer);
        this.stateWaiters.delete(waiter);
        rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
      };
      if (signal?.aborted) {
        waiter.abort();
        return;
      }
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.stateWaiters.add(waiter);
    });
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    const state = await this.waitForState(POST_PARAMETER_AUTH_STATES, START_TIMEOUT_MS, signal);
    if (state !== "authorizationStateReady") {
      throw new Error(`Telegram authorization is ${state}; finish login with the local CLI`);
    }
  }

  async request<T extends Record<string, unknown>>(
    type: string,
    parameters: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.initialized || this.closed || this.closePromise) {
      throw new Error("TDLib client is not available");
    }
    const id = randomUUID();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.removeRequest(id);
        rejectPromise(new Error(`Telegram request timed out (${type})`));
      }, timeoutMs);
      timer.unref();
      const pending: PendingRequest = {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timer,
        ...(signal ? { signal } : {}),
      };
      pending.abort = () => {
        clearTimeout(timer);
        this.requests.delete(id);
        rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
      };
      if (signal?.aborted) {
        pending.abort();
        return;
      }
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.requests.set(id, pending);
      try {
        this.write({
          type: "request",
          id,
          request: { ...parameters, "@type": type },
        });
      } catch {
        this.removeRequest(id);
        rejectPromise(new Error("Could not send request to TDLib worker"));
      }
    });
  }

  waitForSendUpdate(
    temporaryId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TdlibSendUpdate> {
    const previous = this.sendOutcomes.get(temporaryId);
    if (previous) {
      this.sendOutcomes.delete(temporaryId);
      if (previous.error) {
        return Promise.reject(previous.error);
      }
      return Promise.resolve(previous.value);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.sendWaiters.delete(temporaryId);
        signal?.removeEventListener("abort", abort);
        rejectPromise(new Error("Telegram send status is unknown"));
      }, timeoutMs);
      timer.unref();
      const abort = () => {
        clearTimeout(timer);
        this.sendWaiters.delete(temporaryId);
        rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.sendWaiters.set(temporaryId, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolvePromise(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          rejectPromise(error);
        },
        timer,
      });
    });
  }

  close(signal?: AbortSignal): Promise<void> {
    this.closePromise ??= this.closeInternal();
    if (!signal) {
      return this.closePromise;
    }
    return raceWithSignal(this.closePromise, signal).catch(() => this.forceTerminate());
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.authState === "authorizationStateClosed") {
      try {
        await withTimeout(
          this.exitPromise,
          CLOSE_TIMEOUT_MS,
          "TDLib worker did not exit after closing",
        );
      } catch {
        await this.forceTerminate();
      }
      return;
    } else if (!this.initialized) {
      this.child.kill("SIGTERM");
    } else {
      this.write({ type: "close" });
    }
    try {
      await withTimeout(this.exitPromise, CLOSE_TIMEOUT_MS, "TDLib close timed out");
    } catch {
      await this.forceTerminate();
    }
  }

  private async forceTerminate(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.child.kill("SIGTERM");
    try {
      await withTimeout(this.exitPromise, 500, "TDLib worker did not stop");
    } catch {
      this.child.kill("SIGKILL");
      await withTimeout(this.exitPromise, 2_000, "TDLib worker could not be terminated");
    }
  }

  private onData(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_FRAME_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.fail(new Error("TDLib worker output exceeded its frame limit"));
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.fail(new Error("TDLib worker output exceeded its frame limit"));
        return;
      }
      try {
        this.onFrame(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.fail(new Error("TDLib worker returned an invalid frame"));
        return;
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.type === "authorization" && typeof frame.state === "string") {
      this.authState = frame.state;
      for (const waiter of this.stateWaiters) {
        if (waiter.states.has(frame.state)) {
          this.stateWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener("abort", waiter.abort!);
          waiter.resolve(frame.state);
        }
      }
      return;
    }
    if (frame.type === "closed") {
      this.child.stdin.end();
      return;
    }
    if (frame.type === "chat") {
      if (
        typeof frame.id === "number" &&
        typeof frame.title === "string" &&
        typeof frame.kind === "string"
      ) {
        this.chatMap.set(frame.id, {
          id: frame.id,
          title: frame.title,
          kind: frame.kind,
        });
      }
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.removeRequest(frame.id);
      if (!pending) {
        return;
      }
      if (frame.error && typeof frame.error === "object") {
        const errorCode = (frame.error as Record<string, unknown>).code;
        pending.reject(new TdlibRequestError(typeof errorCode === "number" ? errorCode : 500));
      } else if (frame.value && typeof frame.value === "object") {
        pending.resolve(frame.value as Record<string, unknown>);
      } else {
        pending.reject(new Error("TDLib returned an empty response"));
      }
      return;
    }
    if (frame.type === "send_succeeded" || frame.type === "send_failed") {
      if (
        typeof frame.temporaryId === "number" &&
        typeof frame.messageId === "number"
      ) {
        const outcome: SendOutcome =
          frame.type === "send_succeeded"
            ? {
                value: {
                  temporaryId: frame.temporaryId,
                  messageId: frame.messageId,
                },
              }
            : {
                error: new TdlibRequestError(
                  typeof frame.errorCode === "number" ? frame.errorCode : 500,
                ),
              };
        const waiter = this.sendWaiters.get(frame.temporaryId);
        if (waiter) {
          this.sendWaiters.delete(frame.temporaryId);
          clearTimeout(waiter.timer);
          if (outcome.error) {
            waiter.reject(outcome.error);
          } else {
            waiter.resolve(outcome.value);
          }
        } else {
          this.sendOutcomes.set(frame.temporaryId, outcome);
          while (this.sendOutcomes.size > 64) {
            const oldest = this.sendOutcomes.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            this.sendOutcomes.delete(oldest);
          }
        }
      }
      return;
    }
    if (frame.type === "fatal") {
      this.fail(new Error("TDLib worker failed"));
    }
  }

  private write(frame: Record<string, unknown>): void {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      throw new Error("TDLib worker input exceeded its frame limit");
    }
    if (!this.child.stdin.writable) {
      throw new Error("TDLib worker input is closed");
    }
    this.child.stdin.write(line);
  }

  private removeRequest(id: string): PendingRequest | undefined {
    const pending = this.requests.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort!);
      this.requests.delete(id);
    }
    return pending;
  }

  private rejectPending(error: Error): void {
    for (const id of this.requests.keys()) {
      this.removeRequest(id)?.reject(error);
    }
    for (const waiter of this.stateWaiters) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      waiter.reject(error);
    }
    this.stateWaiters.clear();
    for (const [id, waiter] of this.sendWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.sendWaiters.delete(id);
    }
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

export class TdlibRequestError extends Error {
  constructor(readonly code: number) {
    super(`Telegram request failed with code ${code}`);
    this.name = "TdlibRequestError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}
