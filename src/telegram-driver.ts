import { randomUUID } from "node:crypto";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type DriverInstallCatalog,
  type JsonValue,
  type NewConnectorInstallation,
  type SyncSource,
} from "@regenic/connector-contract";
import { TELEGRAM_CONNECTOR_TYPE, TELEGRAM_SOURCE } from "./constants.js";
import { TelegramEgress } from "./telegram-egress.js";
import { SystemKeyring, type TelegramKeyring } from "./keyring.js";
import { validateProfileId } from "./profile.js";
import { TelegramRuntime } from "./runtime.js";
import {
  createTelegramPollConnector,
  createTelegramSyncSource,
  normalizeChatId,
  parseTelegramThreadId,
  telegramStreamKey,
  telegramThreadId,
} from "./telegram-poll.js";
import { resolveTdlibLibrary } from "./tdlib-session.js";
import { telegramLocaleTables } from "./locales.js";

export interface TelegramDriverOptions {
  runtime?: TelegramRuntime;
  keyring?: TelegramKeyring;
}

export function createTelegramDriver(
  options: TelegramDriverOptions = {},
): ChannelDriver {
  const keyring = options.keyring ?? new SystemKeyring();
  const runtime = options.runtime ?? new TelegramRuntime({ keyring });

  const driver: ChannelDriver = {
    connector_type: TELEGRAM_CONNECTOR_TYPE,
    source: TELEGRAM_SOURCE,
    source_mode: "poll",
    connector_protocol: CONNECTOR_PROTOCOL,

    install(input): NewConnectorInstallation {
      const config = telegramInstallConfig(input.config);
      return {
        id: input.id,
        org_id: input.org_id,
        connector_type: TELEGRAM_CONNECTOR_TYPE,
        status: "enabled",
        config,
        created_at: input.now,
      };
    },

    matchesThread(installation, thread) {
      const chatId = parseTelegramThreadId(thread.target);
      return (
        installation.status === "enabled" &&
        thread.source === TELEGRAM_SOURCE &&
        chatId !== undefined &&
        selectedChatIds(installation.config).includes(chatId)
      );
    },

    ownsThread(installation, thread) {
      return driver.matchesThread(installation, thread);
    },

    capabilities(installation) {
      const enabled =
        installation.status === "enabled" &&
        selectedChatIds(installation.config).length > 0;
      return {
        sync: enabled,
        reply: enabled,
        create: false,
        list_title: "conversation",
        hydrate_on_open: enabled,
      };
    },

    async startInstallation(installation) {
      await runtime.startInstallation(installation);
    },

    async stopInstallation(installation, host, context) {
      await runtime.stopInstallation(installation, host, context);
    },

    async resolveStreams(installation, host, _env, options) {
      const threads = options?.threads ?? [];
      const requested = new Set(
        threads
          .filter((thread) => driver.matchesThread(installation, thread))
          .map((thread) => parseTelegramThreadId(thread.target))
          .filter((chatId): chatId is string => chatId !== undefined),
      );
      const chatIds = requireChatIds(installation.config);
      const wanted = chatIds.filter(
        (chatId) => threads.length === 0 || requested.has(chatId),
      );
      for (const chatId of wanted) {
        const catalogLabel = (options?.catalog ?? []).find(
          (member) =>
            member.stream_key === telegramStreamKey(chatId) ||
            parseTelegramThreadId(member.thread_id ?? "") === chatId,
        )?.label;
        await mountTelegramChat(
          host,
          runtime,
          keyring,
          installation,
          chatId,
          catalogLabel,
        );
      }
      const keys = new Set(wanted.map(telegramStreamKey));
      return host
        .get("connectors")
        .listStreams(installation.id)
        .filter((stream) => keys.has(stream.stream_key));
    },

    async resolveThreadStream(installation, thread, host, env) {
      if (!driver.matchesThread(installation, thread)) {
        throw new ChannelDriverError(
          "unsupported_channel",
          "Telegram conversation is not selected in this installation",
        );
      }
      const chatId = parseTelegramThreadId(thread.target);
      if (!chatId) {
        throw new ChannelDriverError("invalid_config", "Telegram thread ID is invalid");
      }
      await mountTelegramChat(host, runtime, keyring, installation, chatId);
      return requireConnectorStream(
        host.get("connectors"),
        installation.id,
        telegramStreamKey(chatId),
      );
    },

    async bindSyncSource(installation): Promise<SyncSource> {
      return createTelegramSyncSource({
        runtime,
        installation,
        chatIds: requireChatIds(installation.config),
      });
    },

    async bindEgress(installation, thread, host, env) {
      await driver.resolveThreadStream(installation, thread, host, env);
      const chatId = parseTelegramThreadId(thread.target);
      if (!chatId) {
        throw new ChannelDriverError("invalid_config", "Telegram thread ID is invalid");
      }
      const adapter = host.get("egress").get(
        installation.id,
        telegramStreamKey(chatId),
      );
      if (!adapter) {
        throw new ChannelDriverError("send_failed", "Telegram egress adapter failed to mount");
      }
      return adapter;
    },

    outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
      return (
        receipt.channel_message_ids?.[0] ??
        receipt.rpc_id ??
        `telegram:${thread.target}:${randomUUID()}`
      );
    },

    locales() {
      return telegramLocaleTables;
    },

    installCatalog(): DriverInstallCatalog {
      return {
        title: "catalog.title",
        channel_label: "catalog.channelLabel",
        description: "catalog.description",
        credential_hint: "catalog.credentialHint",
        fields: [
          {
            key: "profile_id",
            label: "field.profileId",
            required: true,
            default: "default",
            placeholder: "field.profileId.placeholder",
          },
          {
            key: "chat_ids",
            label: "field.chatIds",
            required: true,
            placeholder: "field.chatIds.placeholder",
          },
        ],
        prerequisites: [
          {
            kind: "local_service",
            key: "tdlib",
            label: "prereq.tdlib",
            required: true,
            hint: "prereq.tdlib.hint",
          },
          {
            kind: "local_service",
            key: "system-keychain",
            label: "prereq.keychain",
            required: true,
            hint: "prereq.keychain.hint",
          },
        ],
        setup_steps: [
          { title: "setup.login.title", body: "setup.login.body", command: "regenic-telegram login" },
          { title: "setup.select.title", body: "setup.select.body", command: "regenic-telegram chats" },
        ],
      };
    },

    presentInstall(installation) {
      const count = selectedChatIds(installation.config).length;
      return {
        label: { literal: count === 1 ? "Telegram conversation" : `${count} Telegram conversations` },
        detail: { literal: `Profile: ${profileId(installation.config)}` },
      };
    },

    async probeCatalog() {
      const tdlib = await probeTdlib();
      const supportedPlatform = process.platform === "darwin";
      return {
        services: {
          tdlib: {
            ready: tdlib.ready,
            ...(!tdlib.ready ? { hint: "prereq.tdlib.hint" } : {}),
          },
          "system-keychain": {
            ready: supportedPlatform,
            hint: supportedPlatform
              ? "prereq.keychain.verify"
              : "prereq.keychain.hint",
          },
        },
      };
    },

    async listCatalogFieldOptions() {
      return {};
    },

  };
  return driver;
}

export const telegramDriver = createTelegramDriver();

async function mountTelegramChat(
  host: ConnectorHost,
  runtime: TelegramRuntime,
  keyring: TelegramKeyring,
  installation: ConnectorInstallation,
  chatId: string,
  label?: string,
): Promise<void> {
  const streamKey = telegramStreamKey(chatId);
  const registry = host.get("connectors");
  if (!registry.getStream(installation.id, streamKey)) {
    const poller = createTelegramPollConnector({ runtime, installation, chatId });
    const unregister = registry.register(
      installation.id,
      {
        source: TELEGRAM_SOURCE,
        poll: requirePollFunction(poller.poll),
        source_mode: "poll",
        quota: poller.quota,
      },
      {
        stream_key: streamKey,
        thread_id: telegramThreadId(chatId),
        ...(label ? { label } : {}),
      },
    );
    try {
      host.get("egress").register(
        installation.id,
        new TelegramEgress(runtime, keyring, installation, chatId),
        streamKey,
      );
    } catch (error) {
      unregister();
      throw error;
    }
    return;
  }
  if (!host.get("egress").get(installation.id, streamKey)) {
    host.get("egress").register(
      installation.id,
      new TelegramEgress(runtime, keyring, installation, chatId),
      streamKey,
    );
  }
}

function telegramInstallConfig(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const profile = input.profile_id === undefined ? "default" : input.profile_id;
  const profileId = validateProfileId(profile);
  const chatIds = readChatIds(input.chat_ids);
  if (chatIds.length === 0) {
    throw new ChannelDriverError(
      "invalid_config",
      "Select at least one Telegram conversation using its ID from `regenic-telegram chats`",
    );
  }
  return {
    profile_id: profileId,
    chat_ids: chatIds,
  };
}

function readChatIds(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/).filter(Boolean)
      : [];
  const normalized = values.map(normalizeChatId);
  if (normalized.some((id) => id === undefined)) {
    throw new ChannelDriverError(
      "invalid_config",
      "Telegram conversation IDs must be comma-separated valid numeric chat IDs",
    );
  }
  const chatIds = [...new Set(normalized.filter((id): id is string => id !== undefined))];
  if (chatIds.length > 10_000) {
    throw new ChannelDriverError("invalid_config", "Too many Telegram conversations selected");
  }
  return chatIds;
}

function selectedChatIds(config: Record<string, unknown>): string[] {
  try {
    return readChatIds(config.chat_ids);
  } catch {
    return [];
  }
}

function requireChatIds(config: Record<string, unknown>): string[] {
  const chatIds = readChatIds(config.chat_ids);
  if (chatIds.length === 0) {
    throw new ChannelDriverError(
      "invalid_config",
      "No Telegram conversations are selected for this installation",
    );
  }
  return chatIds;
}

function requirePollFunction(
  poll: ReturnType<typeof createTelegramPollConnector>["poll"],
): NonNullable<ReturnType<typeof createTelegramPollConnector>["poll"]> {
  if (!poll) {
    throw new Error("Telegram poll connector did not expose a poll function");
  }
  return poll;
}

function profileId(config: Record<string, unknown>): string {
  return validateProfileId(config.profile_id);
}

async function probeTdlib(): Promise<{ ready: boolean }> {
  try {
    await resolveTdlibLibrary();
    return { ready: true };
  } catch {
    return { ready: false };
  }
}
