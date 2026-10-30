import type { IngestRecord } from "@regenic/connector-contract";

export function telegramExternalId(chatId: string, messageId: number): string {
  return `${chatId}/${messageId}`;
}

export function parseTelegramExternalId(
  externalId: string | undefined,
  chatId: string,
): number | undefined {
  const prefix = `${chatId}/`;
  if (!externalId?.startsWith(prefix)) {
    return undefined;
  }
  const value = Number(externalId.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function telegramMessageRecord(
  input: {
    chatId: string;
    chatName: string;
    message: Record<string, unknown>;
  },
): IngestRecord | undefined {
  const messageId = safeInteger(input.message.id);
  const date = safeInteger(input.message.date);
  const chatId = Number(input.chatId);
  if (
    messageId === undefined ||
    messageId <= 0 ||
    date === undefined ||
    date <= 0 ||
    !Number.isSafeInteger(chatId)
  ) {
    return undefined;
  }
  const content = record(input.message.content);
  if (content?.["@type"] !== "messageText") {
    return undefined;
  }
  const formattedText = record(content.text);
  const text = formattedText?.text;
  if (typeof text !== "string" || !text.trim()) {
    return undefined;
  }

  const outgoing = input.message.is_outgoing === true;
  const senderId = messageActorId(input.message.sender_id, outgoing);
  const editDate = safeInteger(input.message.edit_date) ?? 0;
  const parentId = replyMessageId(input.message.reply_to);

  return {
    operation: "create",
    source: "telegram",
    external_id: telegramExternalId(input.chatId, messageId),
    ...(editDate > 0 ? { revision_id: `${messageId}:${editDate}` } : {}),
    occurred_at: new Date(date * 1_000).toISOString(),
    actor: {
      id: senderId.id,
      display_name: senderId.displayName,
    },
    scope: {
      id: input.chatId,
      name: input.chatName,
    },
    thread: { id: input.chatId },
    ...(parentId ? { parent_external_id: telegramExternalId(input.chatId, parentId) } : {}),
    type: "message",
    direction_tags: [outgoing ? "outbound" : "inbound"],
    content: [{ role: "body", media_type: "text/plain", text }],
    attrs: {
      outgoing,
      ...(editDate > 0 ? { edited_at: new Date(editDate * 1_000).toISOString() } : {}),
    },
  };
}

function messageActorId(
  value: unknown,
  outgoing: boolean,
): { id: string; displayName: string } {
  if (outgoing) {
    return { id: "self", displayName: "You" };
  }
  const sender = record(value);
  if (sender?.["@type"] === "messageSenderUser") {
    const userId = safeInteger(sender.user_id);
    if (userId !== undefined) {
      return { id: `user:${userId}`, displayName: `Telegram user ${userId}` };
    }
  }
  if (sender?.["@type"] === "messageSenderChat") {
    const chatId = safeInteger(sender.chat_id);
    if (chatId !== undefined) {
      return { id: `chat:${chatId}`, displayName: `Telegram chat ${chatId}` };
    }
  }
  return { id: "unknown", displayName: "Unknown Telegram sender" };
}

function replyMessageId(value: unknown): number | undefined {
  const reply = record(value);
  if (reply?.["@type"] !== "messageReplyToMessage") {
    return undefined;
  }
  const messageId = safeInteger(reply.message_id);
  return messageId !== undefined && messageId > 0 ? messageId : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
