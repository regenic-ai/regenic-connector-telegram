import { randomUUID } from "node:crypto";
import {
  ChannelDriverError,
  SendNotAcceptedError,
  type DeliveryReceipt,
  type EgressAdapter,
  type EgressCapabilities,
  type ConnectorInstallation,
  type SendIntent,
} from "@regenic/connector-contract";
import { ensureProfileDirectory, validateProfileId } from "./profile.js";
import {
  assertDatabaseKey,
  getOrCreateDatabaseKey,
  type TelegramKeyring,
} from "./keyring.js";
import {
  FileEncryptedOutbox,
  telegramSendFingerprint,
  type OutboxEntry,
} from "./outbox.js";
import { TelegramRuntime } from "./runtime.js";
import { TdlibRequestError } from "./tdlib-session.js";
import { telegramChatKind } from "./telegram-chat.js";
import { parseTelegramExternalId } from "./telegram-message.js";
import { TELEGRAM_SOURCE } from "./constants.js";

const SEND_STATUS_TIMEOUT_MS = 30_000;

export class TelegramEgress implements EgressAdapter {
  readonly source = TELEGRAM_SOURCE;

  constructor(
    private readonly runtime: TelegramRuntime,
    private readonly keyring: TelegramKeyring,
    private readonly installation: ConnectorInstallation,
    private readonly chatId: string,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.installation.id) {
      throw new SendNotAcceptedError(
        "invalid_config",
        "Telegram send intent does not match this installation",
      );
    }
    const text = textBody(intent);
    if (intent.target?.scope_id && intent.target.scope_id !== this.chatId) {
      throw new SendNotAcceptedError(
        "invalid_config",
        "Telegram send target does not match the selected conversation",
      );
    }
    const replyTo = parseTelegramExternalId(intent.target?.external_id, this.chatId);
    if (intent.target?.external_id && replyTo === undefined) {
      throw new SendNotAcceptedError(
        "invalid_config",
        "Telegram reply target is not a message in the selected conversation",
      );
    }
    const idempotencyKey = intent.idempotency_key ?? randomUUID();
    const fingerprint = telegramSendFingerprint({
      chatId: this.chatId,
      text,
      ...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
    });

    return this.runtime.withClient(this.installation, async (client, signal) => {
      const chat = await client.request<Record<string, unknown>>(
        "getChat",
        { chat_id: Number(this.chatId) },
        undefined,
        signal,
      );
      if (!telegramChatKind(chat)) {
        throw new SendNotAcceptedError(
          "unsupported_channel",
          "Telegram replies are supported only in private or group conversations",
        );
      }
      const profileId = validateProfileId(this.installation.config.profile_id);
      const directory = await ensureProfileDirectory(profileId);
      const encodedKey = await getOrCreateDatabaseKey(this.keyring, profileId);
      assertDatabaseKey(encodedKey);
      const outbox = new FileEncryptedOutbox(
        `${directory}/outbox.bin`,
        profileId,
        Buffer.from(encodedKey, "base64"),
      );
      const previous = await outbox.begin({ idempotencyKey, fingerprint });
      if (previous) {
        return handlePreviousOutbox(outbox, idempotencyKey, fingerprint, previous);
      }

      let temporaryId: number;
      try {
        const message = await client.request<{ id?: number }>(
          "sendMessage",
          sendMessageParameters(this.chatId, text, replyTo),
          undefined,
          signal,
        );
        if (!isInteger(message.id) || message.id === 0) {
          await outbox.update(idempotencyKey, fingerprint, { state: "unknown" });
          throw unknownSendOutcome();
        }
        temporaryId = message.id;
      } catch (error) {
        if (error instanceof ChannelDriverError) {
          throw error;
        }
        if (error instanceof TdlibRequestError && isDefiniteRejection(error.code)) {
          await outbox.update(idempotencyKey, fingerprint, {
            state: "rejected",
            error_code: error.code,
          });
          throw rejectedSend(error.code);
        }
        await outbox.update(idempotencyKey, fingerprint, { state: "unknown" });
        throw unknownSendOutcome();
      }

      let messageId = temporaryId;
      if (temporaryId < 0) {
        try {
          const outcome = await client.waitForSendUpdate(
            temporaryId,
            SEND_STATUS_TIMEOUT_MS,
            signal,
          );
          messageId = outcome.messageId;
        } catch (error) {
          if (error instanceof TdlibRequestError) {
            await outbox.update(idempotencyKey, fingerprint, {
              state: "rejected",
              error_code: error.code,
            });
            throw rejectedSend(error.code);
          }
          await outbox.update(idempotencyKey, fingerprint, { state: "unknown" });
          throw unknownSendOutcome();
        }
      }

      const externalId = `${this.chatId}/${messageId}`;
      await outbox.update(idempotencyKey, fingerprint, {
        state: "accepted",
        external_id: externalId,
      });
      return {
        accepted: true,
        rpc_id: externalId,
        channel_message_ids: [externalId],
      };
    });
  }
}

function textBody(intent: SendIntent): string {
  if (
    intent.content.length !== 1 ||
    intent.content[0]?.role !== "body" ||
    intent.content[0].media_type !== "text/plain" ||
    typeof intent.content[0].text !== "string" ||
    !intent.content[0].text.trim()
  ) {
    throw new SendNotAcceptedError(
      "unsupported_channel",
      "Telegram supports one non-empty plain-text message per send",
    );
  }
  return intent.content[0].text;
}

function sendMessageParameters(
  chatId: string,
  text: string,
  replyTo: number | undefined,
): Record<string, unknown> {
  return {
    chat_id: Number(chatId),
    topic_id: null,
    reply_to:
      replyTo === undefined
        ? null
        : {
            "@type": "inputMessageReplyToMessage",
            message_id: replyTo,
            quote: null,
            checklist_task_id: 0,
            poll_option_id: "",
          },
    options: {
      "@type": "messageSendOptions",
      suggested_post_info: null,
      disable_notification: false,
      from_background: false,
      protect_content: false,
      allow_paid_broadcast: false,
      paid_message_star_count: 0,
      update_order_of_installed_sticker_sets: false,
      scheduling_state: null,
      effect_id: 0,
      sending_id: 0,
      only_preview: false,
    },
    reply_markup: null,
    input_message_content: {
      "@type": "inputMessageText",
      text: {
        "@type": "formattedText",
        text,
        entities: [],
      },
      link_preview_options: {
        "@type": "linkPreviewOptions",
        is_disabled: true,
        url: "",
        force_small_media: false,
        force_large_media: false,
        show_above_text: false,
      },
      clear_draft: false,
    },
  };
}

function handlePreviousOutbox(
  outbox: FileEncryptedOutbox,
  idempotencyKey: string,
  fingerprint: string,
  previous: OutboxEntry,
): Promise<DeliveryReceipt> {
  if (previous.state === "accepted" && previous.external_id) {
    return Promise.resolve({
      accepted: true,
      rpc_id: previous.external_id,
      channel_message_ids: [previous.external_id],
    });
  }
  if (previous.state === "pending") {
    return outbox
      .update(idempotencyKey, fingerprint, { state: "unknown" })
      .then(() => {
        throw unknownSendOutcome();
      });
  }
  if (previous.state === "rejected") {
    throw rejectedSend(previous.error_code);
  }
  throw unknownSendOutcome();
}

function rejectedSend(code?: number): SendNotAcceptedError {
  return new SendNotAcceptedError(
    code === 429 ? "throttled" : "send_failed",
    code === 429
      ? "Telegram is rate-limiting this send; review the account before retrying"
      : "Telegram rejected this send; use a new idempotency key only after reviewing the failure",
  );
}

function unknownSendOutcome(): ChannelDriverError {
  return new ChannelDriverError(
    "send_failed",
    "Telegram send outcome is unknown; it was not retried. Check Telegram before sending again",
  );
}

function isDefiniteRejection(code: number): boolean {
  return code === 400 || code === 403 || code === 429;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
