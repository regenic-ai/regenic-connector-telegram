import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MAGIC = Buffer.from("RTG1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;

export type OutboxState = "pending" | "unknown" | "accepted" | "rejected";

export interface OutboxEntry {
  state: OutboxState;
  fingerprint: string;
  updated_at: string;
  external_id?: string;
  error_code?: number;
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (entry.state === "pending" ||
      entry.state === "unknown" ||
      entry.state === "accepted" ||
      entry.state === "rejected") &&
    typeof entry.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
    typeof entry.updated_at === "string" &&
    Number.isFinite(Date.parse(entry.updated_at)) &&
    (entry.external_id === undefined || typeof entry.external_id === "string") &&
    (entry.error_code === undefined ||
      (typeof entry.error_code === "number" && Number.isSafeInteger(entry.error_code))) &&
    (entry.state !== "accepted" || typeof entry.external_id === "string")
  );
}

export interface EncryptedOutbox {
  begin(input: {
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<OutboxEntry | undefined>;
  update(
    idempotencyKey: string,
    fingerprint: string,
    update: Omit<OutboxEntry, "fingerprint" | "updated_at">,
  ): Promise<void>;
}

export class FileEncryptedOutbox implements EncryptedOutbox {
  constructor(
    private readonly path: string,
    private readonly profileId: string,
    private readonly key: Buffer,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (key.length !== 32) {
      throw new Error("Telegram outbox encryption key must be 32 bytes");
    }
  }

  async begin(input: {
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<OutboxEntry | undefined> {
    if (!input.idempotencyKey || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
      throw new Error("Telegram outbox operation identity is invalid");
    }
    const entries = await this.read();
    const key = hash(input.idempotencyKey);
    const existing = entries[key];
    if (existing && existing.fingerprint !== input.fingerprint) {
      throw new Error("Telegram idempotency key was reused with different content");
    }
    if (existing) {
      return existing;
    }
    const entry: OutboxEntry = {
      state: "pending",
      fingerprint: input.fingerprint,
      updated_at: this.now(),
    };
    if (!isOutboxEntry(entry)) {
      throw new Error("Telegram outbox timestamp is invalid");
    }
    entries[key] = entry;
    await this.write(entries);
    return undefined;
  }

  async update(
    idempotencyKey: string,
    fingerprint: string,
    update: Omit<OutboxEntry, "fingerprint" | "updated_at">,
  ): Promise<void> {
    const entries = await this.read();
    const key = hash(idempotencyKey);
    const existing = entries[key];
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new Error("Telegram outbox operation is missing or has changed");
    }
    if (existing.state !== "pending") {
      throw new Error("Telegram outbox operation is already in a final state");
    }
    if (update.state === "accepted" && !update.external_id) {
      throw new Error("Accepted Telegram sends must include an external message ID");
    }
    const entry: OutboxEntry = {
      ...existing,
      ...update,
      fingerprint,
      updated_at: this.now(),
    };
    if (!isOutboxEntry(entry)) {
      throw new Error("Telegram outbox update is invalid");
    }
    entries[key] = entry;
    await this.write(entries);
  }

  private async read(): Promise<Record<string, OutboxEntry>> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
    if (bytes.length > MAX_OUTBOX_BYTES || bytes.length < MAGIC.length + NONCE_BYTES + TAG_BYTES) {
      throw new Error("Telegram outbox is invalid or too large");
    }
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Telegram outbox version is unsupported");
    }
    const nonceStart = MAGIC.length;
    const tagStart = bytes.length - TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(nonceStart, nonceStart + NONCE_BYTES),
    );
    decipher.setAAD(Buffer.from(this.profileId));
    decipher.setAuthTag(bytes.subarray(tagStart));
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(nonceStart + NONCE_BYTES, tagStart)),
      decipher.final(),
    ]);
    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Telegram outbox payload is invalid");
    }
    const entries = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !isOutboxEntry(entry)) {
        throw new Error("Telegram outbox entry is invalid");
      }
    }
    return entries as Record<string, OutboxEntry>;
  }

  private async write(entries: Record<string, OutboxEntry>): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(entries));
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(this.profileId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encoded = Buffer.concat([MAGIC, nonce, ciphertext, cipher.getAuthTag()]);
    if (encoded.length > MAX_OUTBOX_BYTES) {
      throw new Error("Telegram outbox reached its safety size limit");
    }
    const temporary = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function telegramSendFingerprint(input: {
  chatId: string;
  text: string;
  replyTo?: string;
}): string {
  return hash(JSON.stringify(input));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
