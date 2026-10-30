import { createHash } from "node:crypto";
import {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  type ChannelConnector,
  type ConnectorCursor,
  type ConnectorInstallation,
  type ConnectorPollOptions,
  type IngestRecord,
  type PollResult,
  type SyncDirectoryMember,
  type SyncSource,
} from "@regenic/connector-contract";
import {
  TELEGRAM_DIRECTORY_PAGE_SIZE,
  TELEGRAM_DIRECTORY_MAX,
  TELEGRAM_HISTORY_PAGE_SIZE,
  TELEGRAM_SOURCE,
} from "./constants.js";
import { TelegramRuntime } from "./runtime.js";
import { telegramChatKind } from "./telegram-chat.js";
import type { TdlibClient } from "./tdlib-session.js";
import {
  parseTelegramExternalId,
  telegramMessageRecord,
} from "./telegram-message.js";

interface TelegramCursor {
  version: 1;
  chat_id: string;
  last_message_id?: number;
  oldest_history_id?: number;
  catchup_anchor_id?: number;
  catchup_target_id?: number;
}

export function createTelegramPollConnector(input: {
  runtime: TelegramRuntime;
  installation: ConnectorInstallation;
  chatId: string;
  chatName?: string;
  now?: () => string;
}): ChannelConnector {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    source: TELEGRAM_SOURCE,
    quota: { tokens: 1, window_ms: 1_000 },
    capabilities: () => ({
      webhook: false,
      poll: true,
      backfill: true,
      member_sync: false,
      edits: false,
      tombstones: false,
      attachments: false,
    }),
    poll: async (cursor, options) => {
      if (options?.media === true) {
        throw new ChannelDriverError(
          "unsupported_channel",
          "Telegram media synchronization is not supported",
        );
      }
      const state = decodeTelegramCursor(cursor, input.chatId);
      return input.runtime.withClient(
        input.installation,
        (client, signal) =>
          pollTelegramChat(client, {
            connectorId: input.installation.id,
            orgId: input.installation.org_id,
            chatId: input.chatId,
            ...(input.chatName ? { chatName: input.chatName } : {}),
            state,
            ...(options ? { options } : {}),
            now,
            signal,
          }),
        options?.signal,
      );
    },
  };
}

export function createTelegramSyncSource(input: {
  runtime: TelegramRuntime;
  installation: ConnectorInstallation;
  chatIds?: readonly string[];
}): SyncSource {
  let directory: SyncDirectoryMember[] | undefined;
  return {
    listDirectory: async (cursor) => {
      const offset = parseDirectoryCursor(cursor);
      if (!directory) {
        directory = await input.runtime.withClient(
          input.installation,
          (client, signal) =>
            loadTelegramDirectory(client, {
              ...(input.chatIds ? { selectedChatIds: input.chatIds } : {}),
              signal,
            }),
        );
      }
      const page = directory.slice(offset, offset + TELEGRAM_DIRECTORY_PAGE_SIZE);
      const nextOffset = offset + page.length;
      const complete = nextOffset >= directory.length;
      return {
        members: page,
        ...(complete ? {} : { next_cursor: String(nextOffset) }),
        complete,
        ...(offset === 0 ? { replaces: true } : {}),
      };
    },
  };
}

async function pollTelegramChat(
  client: TdlibClient,
  input: {
    connectorId: string;
    orgId: string;
    chatId: string;
    chatName?: string;
    state: TelegramCursor;
    options?: ConnectorPollOptions;
    now: () => string;
    signal: AbortSignal;
  },
): Promise<PollResult> {
  const chatResponse = await client.request<Record<string, unknown>>(
    "getChat",
    { chat_id: Number(input.chatId) },
    undefined,
    input.signal,
  );
  if (!telegramChatKind(chatResponse)) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Telegram selection is not a supported private or group conversation",
    );
  }
  const chatName =
    input.chatName?.trim() ||
    (typeof chatResponse.title === "string" ? chatResponse.title : input.chatId);
  const older = input.options?.older === true;
  const historyAnchor = older
    ? parseTelegramExternalId(input.options?.before_external_id, input.chatId) ??
      input.state.oldest_history_id
    : undefined;
  if (older && historyAnchor === undefined) {
    throw new ChannelDriverError(
      "sync_failed",
      "Telegram history pagination requires a previously loaded message cursor",
    );
  }
  const catchup = !older && !input.options?.latest
    ? input.state.catchup_anchor_id
    : undefined;
  const liveAnchor = !older && !input.options?.latest
    ? input.state.last_message_id
    : undefined;

  const response = await client.request<{ messages?: unknown[] }>(
    "getChatHistory",
    {
      chat_id: Number(input.chatId),
      from_message_id: historyAnchor ?? catchup ?? 0,
      offset: 0,
      limit: TELEGRAM_HISTORY_PAGE_SIZE,
      only_local: false,
    },
    undefined,
    input.signal,
  );
  const messages = Array.isArray(response.messages)
    ? response.messages.filter(isObject)
    : [];
  const messageIds = messages
    .map((message) => message.id)
    .filter(isSafePositiveInteger);
  const previousLast = input.state.last_message_id;
  const selectedMessages = messages
    .filter((message) => {
      const messageId = message.id;
      if (!isSafePositiveInteger(messageId)) {
        return false;
      }
      if (older) {
        return messageId < (historyAnchor ?? 0);
      }
      if (catchup !== undefined && messageId >= catchup) {
        return false;
      }
      if (liveAnchor !== undefined && messageId <= liveAnchor) {
        return false;
      }
      return true;
    })
    .sort((left, right) => Number(left.id) - Number(right.id));

  const records = selectedMessages.flatMap((message) => {
    const record = telegramMessageRecord({
      chatId: input.chatId,
      chatName,
      message,
    });
    return record ? [record] : [];
  });
  const newestId = messageIds.length > 0 ? Math.max(...messageIds) : undefined;
  const oldestId = messageIds.length > 0 ? Math.min(...messageIds) : undefined;
  const earlierCatchupIds =
    catchup === undefined
      ? []
      : messageIds.filter((messageId) => messageId < catchup);
  const nextCatchupAnchor =
    catchup === undefined
      ? oldestId
      : earlierCatchupIds.length > 0
        ? Math.min(...earlierCatchupIds)
        : undefined;
  const state: TelegramCursor = { version: 1, chat_id: input.chatId };
  const oldestHistoryId = minOptional(input.state.oldest_history_id, oldestId);
  if (oldestHistoryId !== undefined) {
    state.oldest_history_id = oldestHistoryId;
  }
  if (older) {
    if (previousLast !== undefined) {
      state.last_message_id = previousLast;
    }
    if (input.state.catchup_anchor_id !== undefined) {
      state.catchup_anchor_id = input.state.catchup_anchor_id;
    }
    if (input.state.catchup_target_id !== undefined) {
      state.catchup_target_id = input.state.catchup_target_id;
    }
  } else if (input.options?.latest) {
    const newest = newestId ?? previousLast;
    if (newest !== undefined) {
      state.last_message_id = newest;
    }
  } else {
    const targetId = input.state.catchup_target_id ?? newestId;
    const caughtUp =
      liveAnchor === undefined ||
      (oldestId !== undefined && oldestId <= liveAnchor) ||
      (catchup !== undefined && oldestId !== undefined && nextCatchupAnchor === undefined);
    if (caughtUp) {
      const newest = targetId ?? liveAnchor;
      if (newest !== undefined) {
        state.last_message_id = Math.max(previousLast ?? 0, newest);
      }
    } else {
      if (previousLast !== undefined) {
        state.last_message_id = previousLast;
      }
      if (nextCatchupAnchor !== undefined && liveAnchor !== undefined) {
        state.catchup_anchor_id = nextCatchupAnchor;
        if (targetId !== undefined) {
          state.catchup_target_id = targetId;
        }
      } else if (input.state.catchup_anchor_id !== undefined) {
        state.catchup_anchor_id = input.state.catchup_anchor_id;
        if (input.state.catchup_target_id !== undefined) {
          state.catchup_target_id = input.state.catchup_target_id;
        }
      } else if (newestId !== undefined) {
        state.last_message_id = newestId;
      }
    }
  }
  const hasMoreHistory = messages.length >= TELEGRAM_HISTORY_PAGE_SIZE;
  const hasMoreCatchup = state.catchup_anchor_id !== undefined;
  const nextCursor = JSON.stringify(state);
  const batch = {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: input.connectorId,
    org_id: input.orgId,
    delivery_id: createHash("sha256")
      .update(
        JSON.stringify({
          connector_id: input.connectorId,
          chat_id: input.chatId,
          cursor: input.state,
          options: {
            older: input.options?.older,
            latest: input.options?.latest,
            before: input.options?.before,
            before_external_id: input.options?.before_external_id,
          },
          records,
        }),
      )
      .digest("hex"),
    records,
    next_cursor: nextCursor,
    received_at: input.now(),
  };
  return {
    batch,
    next_cursor: nextCursor,
    has_more: older ? hasMoreHistory : hasMoreCatchup,
    poll_hint: {
      live_seeded: !older,
      history_pending: older && hasMoreHistory,
    },
  };
}

async function loadTelegramDirectory(
  client: TdlibClient,
  input: {
    selectedChatIds?: readonly string[];
    signal: AbortSignal;
  },
): Promise<SyncDirectoryMember[]> {
  const selected = [...new Set(input.selectedChatIds ?? [])];
  if (selected.length > TELEGRAM_DIRECTORY_MAX) {
    throw new ChannelDriverError(
      "invalid_config",
      `Telegram supports selecting up to ${TELEGRAM_DIRECTORY_MAX} conversations`,
    );
  }

  const members: SyncDirectoryMember[] = [];
  for (const idText of selected) {
    const chat = await client.request<Record<string, unknown>>(
      "getChat",
      { chat_id: Number(idText) },
      undefined,
      input.signal,
    );
    const kind = telegramChatKind(chat);
    if (!kind) {
      continue;
    }
    members.push({
      stream_key: telegramStreamKey(idText),
      thread_id: telegramThreadId(idText),
      label:
        typeof chat.title === "string" && chat.title.trim()
          ? chat.title
          : idText,
      kind,
    });
  }
  return members;
}

export function decodeTelegramCursor(
  cursor: ConnectorCursor | null,
  chatId: string,
): TelegramCursor {
  if (!cursor) {
    return { version: 1, chat_id: chatId };
  }
  let value: unknown;
  try {
    value = JSON.parse(cursor.value) as unknown;
  } catch {
    throw new ChannelDriverError("sync_failed", "Telegram cursor is invalid");
  }
  if (!isTelegramCursor(value) || value.chat_id !== chatId) {
    throw new ChannelDriverError("sync_failed", "Telegram cursor does not match this chat");
  }
  return value;
}

export function telegramStreamKey(chatId: string): string {
  return `chat:${chatId}`;
}

export function telegramThreadId(chatId: string): string {
  return `${TELEGRAM_SOURCE}:${chatId}`;
}

export function parseTelegramThreadId(threadId: string): string | undefined {
  const prefix = `${TELEGRAM_SOURCE}:`;
  if (!threadId.startsWith(prefix)) {
    return undefined;
  }
  return normalizeChatId(threadId.slice(prefix.length));
}

export function normalizeChatId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  if (!/^-?\d{1,15}$/.test(text)) {
    return undefined;
  }
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) && numeric !== 0 ? String(numeric) : undefined;
}

function parseDirectoryCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new ChannelDriverError("sync_failed", "Telegram directory cursor is invalid");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset > TELEGRAM_DIRECTORY_MAX) {
    throw new ChannelDriverError("sync_failed", "Telegram directory cursor is out of range");
  }
  return offset;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isTelegramCursor(value: unknown): value is TelegramCursor {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.chat_id === "string" &&
    (value.last_message_id === undefined || isSafePositiveInteger(value.last_message_id)) &&
    (value.oldest_history_id === undefined || isSafePositiveInteger(value.oldest_history_id)) &&
    (value.catchup_anchor_id === undefined || isSafePositiveInteger(value.catchup_anchor_id)) &&
    (value.catchup_target_id === undefined || isSafePositiveInteger(value.catchup_target_id))
  );
}

function minOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}
