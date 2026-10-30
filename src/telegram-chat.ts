export function telegramChatKind(value: unknown): "private" | "group" | undefined {
  const chat = record(value);
  const type = record(chat?.type);
  if (type?.["@type"] === "chatTypePrivate") {
    return "private";
  }
  if (type?.["@type"] === "chatTypeBasicGroup") {
    return "group";
  }
  if (type?.["@type"] === "chatTypeSupergroup" && type.is_channel !== true) {
    return "group";
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
