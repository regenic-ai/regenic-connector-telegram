#!/usr/bin/env node
import { emitKeypressEvents } from "node:readline";
import {
  assertApiCredentials,
  SystemKeyring,
} from "./keyring.js";
import { validateProfileId } from "./profile.js";
import {
  openTdlibClient,
  resolveTdlibLibrary,
  TdlibRequestError,
  type TdlibClient,
} from "./tdlib-session.js";
import { TELEGRAM_DIRECTORY_MAX, TELEGRAM_DIRECTORY_PAGE_SIZE } from "./constants.js";

const keyring = new SystemKeyring();

async function main(): Promise<void> {
  const command = process.argv[2];
  const profileId = validateProfileId(process.argv[3] ?? "default");
  if (command === "login") {
    await login(profileId);
    return;
  }
  if (command === "chats") {
    await printChats(profileId);
    return;
  }
  if (command === "logout") {
    await logout(profileId);
    return;
  }
  process.stdout.write(
    "Usage: regenic-telegram <login|chats|logout> [profile-id]\n",
  );
}

async function login(profileId: string): Promise<void> {
  await resolveTdlibLibrary();
  const apiIdText = await readHidden("Telegram API ID: ");
  const apiHash = await readHidden("Telegram API hash: ");
  const credentials = assertApiCredentials(apiIdText, apiHash);
  await keyring.write(profileId, "api-id", String(credentials.apiId));
  await keyring.write(profileId, "api-hash", credentials.apiHash);

  const client = await openTdlibClient({ profileId, keyring });
  try {
    for (;;) {
      const state = await waitForAuthorization(client);
      if (state === "authorizationStateReady") {
        process.stdout.write("Telegram login is ready for this local profile.\n");
        return;
      }
      if (state === "authorizationStateWaitPhoneNumber") {
        const phoneNumber = await readHidden("Phone number (international format): ");
        await client.request("setAuthenticationPhoneNumber", {
          phone_number: phoneNumber,
          settings: {
            "@type": "phoneNumberAuthenticationSettings",
            allow_flash_call: false,
            allow_missed_call: false,
            is_current_phone_number: false,
            has_unknown_phone_number: false,
            allow_sms_retriever_api: false,
            firebase_authentication_settings: null,
            authentication_tokens: [],
          },
        });
        continue;
      }
      if (state === "authorizationStateWaitCode") {
        const code = await readHidden("Telegram login code: ");
        await client.request("checkAuthenticationCode", { code });
        continue;
      }
      if (state === "authorizationStateWaitPassword") {
        const password = await readHidden("Telegram two-step verification password: ");
        await client.request("checkAuthenticationPassword", { password });
        continue;
      }
      if (state === "authorizationStateWaitEmailAddress") {
        const email = await readHidden("Telegram login email: ");
        await client.request("setAuthenticationEmailAddress", {
          email_address: email,
        });
        continue;
      }
      if (state === "authorizationStateWaitEmailCode") {
        const code = await readHidden("Telegram email login code: ");
        await client.request("checkAuthenticationEmailCode", {
          code: { "@type": "emailAddressAuthenticationCode", code },
        });
        continue;
      }
      throw new Error(
        `Telegram authorization requires unsupported state ${state}; no account action was taken`,
      );
    }
  } finally {
    await client.close();
  }
}

async function printChats(profileId: string): Promise<void> {
  const client = await openAuthorizedClient(profileId);
  try {
    const chatIds = new Set<number>();
    const chatList = { "@type": "chatListMain" };
    for (
      let requested = TELEGRAM_DIRECTORY_PAGE_SIZE;
      requested <= TELEGRAM_DIRECTORY_MAX;
      requested += TELEGRAM_DIRECTORY_PAGE_SIZE
    ) {
      try {
        await client.request("loadChats", {
          chat_list: chatList,
          limit: TELEGRAM_DIRECTORY_PAGE_SIZE,
        });
      } catch (error) {
        if (error instanceof TdlibRequestError && error.code === 404) {
          break;
        }
        throw error;
      }
      const response = await client.request<{ chats?: unknown[] }>("getChats", {
        chat_list: chatList,
        limit: requested,
      });
      const before = chatIds.size;
      for (const id of response.chats ?? []) {
        if (typeof id === "number" && Number.isSafeInteger(id) && id !== 0) {
          chatIds.add(id);
        }
      }
      if (chatIds.size === before || chatIds.size >= TELEGRAM_DIRECTORY_MAX) {
        break;
      }
    }

    process.stdout.write("ID\tTYPE\tCONVERSATION\n");
    for (const id of chatIds) {
      const chat = await client.request<Record<string, unknown>>("getChat", {
        chat_id: id,
      });
      const chatType = isObject(chat.type) ? chat.type : undefined;
      const type = chatType?.["@type"];
      const kind =
        type === "chatTypePrivate"
          ? "private"
          : type === "chatTypeSupergroup" && chatType?.is_channel === true
            ? "channel"
            : type === "chatTypeBasicGroup" || type === "chatTypeSupergroup"
            ? "group"
            : "other";
      const title =
        typeof chat.title === "string"
          ? chat.title.replace(/[\t\r\n]+/g, " ").trim()
          : "";
      process.stdout.write(`${id}\t${kind}\t${title || "(untitled)"}\n`);
    }
  } finally {
    await client.close();
  }
}

async function logout(profileId: string): Promise<void> {
  const confirmation = await readHidden(
    `This signs the Telegram account out remotely. Type LOGOUT to continue: `,
  );
  if (confirmation !== "LOGOUT") {
    process.stdout.write("Telegram logout cancelled.\n");
    return;
  }
  const client = await openAuthorizedClient(profileId);
  try {
    await client.request("logOut");
    await client.waitForState(["authorizationStateClosed"], 30_000);
    process.stdout.write(
      "Telegram account logged out. API credentials and local profile remain stored.\n",
    );
  } finally {
    await client.close();
  }
}

async function openAuthorizedClient(profileId: string): Promise<TdlibClient> {
  const client = await openTdlibClient({ profileId, keyring });
  try {
    await client.waitUntilReady();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function waitForAuthorization(client: TdlibClient): Promise<string> {
  const knownStates = [
    "authorizationStateWaitPhoneNumber",
    "authorizationStateWaitCode",
    "authorizationStateWaitPassword",
    "authorizationStateWaitEmailAddress",
    "authorizationStateWaitEmailCode",
    "authorizationStateWaitOtherDeviceConfirmation",
    "authorizationStateWaitRegistration",
    "authorizationStateWaitPremiumPurchase",
    "authorizationStateLoggingOut",
    "authorizationStateClosing",
    "authorizationStateReady",
    "authorizationStateClosed",
  ];
  return client.authorizationState && knownStates.includes(client.authorizationState)
    ? client.authorizationState
    : client.waitForState(knownStates, 120_000);
}

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("This command requires an interactive local terminal");
  }
  emitKeypressEvents(process.stdin);
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    let value = "";
    let settled = false;
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        finish(new Error("Interactive input cancelled"));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
      } else if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && value.length < 512) {
        value += character;
      }
    };
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Telegram CLI failed";
  process.stderr.write(`regenic-telegram: ${message}\n`);
  process.exitCode = 1;
});
