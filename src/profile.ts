import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateProfileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID.test(value)) {
    throw new Error("Telegram profile ID must be 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

export function telegramDataRoot(): string {
  if (process.platform !== "darwin") {
    throw new Error("Telegram connector runtime is currently supported only on macOS");
  }
  return join(homedir(), "Library", "Application Support", "Regenic", "Telegram");
}

export async function ensureProfileDirectory(profileId: string): Promise<string> {
  const root = telegramDataRoot();
  await ensurePrivateDirectory(root);
  const directory = join(root, validateProfileId(profileId));
  await ensurePrivateDirectory(directory);
  return directory;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Telegram profile storage path is not a private directory");
  }
  await chmod(path, 0o700);
}
