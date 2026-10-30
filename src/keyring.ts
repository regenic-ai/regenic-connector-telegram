import { randomBytes } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { validateProfileId } from "./profile.js";

const SERVICE = "regenic-telegram";
const DATABASE_KEY_BYTES = 32;

export type TelegramSecretName = "api-id" | "api-hash" | "database-key";

export interface TelegramKeyring {
  read(profileId: string, name: TelegramSecretName): Promise<string | undefined>;
  write(profileId: string, name: TelegramSecretName, secret: string): Promise<void>;
  delete(profileId: string, name: TelegramSecretName): Promise<boolean>;
}

export class SystemKeyring implements TelegramKeyring {
  async read(profileId: string, name: TelegramSecretName): Promise<string | undefined> {
    const value = await keyringEntry(profileId, name).getPassword();
    return value ?? undefined;
  }

  async write(profileId: string, name: TelegramSecretName, secret: string): Promise<void> {
    if (!secret) {
      throw new Error("Refusing to store an empty Telegram credential");
    }
    await keyringEntry(profileId, name).setPassword(secret);
  }

  async delete(profileId: string, name: TelegramSecretName): Promise<boolean> {
    return keyringEntry(profileId, name).deletePassword();
  }
}

export async function getOrCreateDatabaseKey(
  keyring: TelegramKeyring,
  profileId: string,
): Promise<string> {
  const existing = await keyring.read(profileId, "database-key");
  if (existing) {
    assertDatabaseKey(existing);
    return existing;
  }

  const generated = randomBytes(DATABASE_KEY_BYTES).toString("base64");
  await keyring.write(profileId, "database-key", generated);
  return generated;
}

export function assertDatabaseKey(encoded: string): void {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== DATABASE_KEY_BYTES || decoded.toString("base64") !== encoded) {
    throw new Error("Stored Telegram database key is invalid; refusing unencrypted fallback");
  }
}

export function assertApiCredentials(apiId: string | undefined, apiHash: string | undefined): {
  apiId: number;
  apiHash: string;
} {
  const numericId = apiId && /^[1-9]\d{0,8}$/.test(apiId) ? Number(apiId) : NaN;
  if (!Number.isSafeInteger(numericId) || !apiHash || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
    throw new Error("Telegram API credentials are missing or invalid; run `regenic-telegram login` locally");
  }
  return { apiId: numericId, apiHash };
}

function keyringEntry(profileId: string, name: TelegramSecretName): AsyncEntry {
  if (process.platform !== "darwin") {
    throw new Error("Telegram system-keychain storage is currently supported only on macOS");
  }
  return new AsyncEntry(SERVICE, `${validateProfileId(profileId)}:${name}`);
}
