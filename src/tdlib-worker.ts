import { createInterface } from "node:readline";
import { load } from "koffi";

interface InitFrame {
  type: "init";
  nativeLibrary: string;
  apiId: number;
  apiHash: string;
  databaseKey: string;
  databaseDirectory: string;
  filesDirectory: string;
}

interface RequestFrame {
  type: "request";
  id: string;
  request: Record<string, unknown>;
}

interface ControlFrame {
  type: "close" | "logout";
}

type InputFrame = InitFrame | RequestFrame | ControlFrame;

const MAX_INPUT_LINE = 1024 * 1024;
const MAX_OUTPUT_LINE = 8 * 1024 * 1024;
const pending = new Set<string>();
let sendRequest: ((clientId: number, request: string) => void) | undefined;
let receiveUpdates: { async: (timeout: number, callback: (error: Error | null, value: string | null) => void) => void } | undefined;
let clientId: number | undefined;
let initialized = false;
let closeRequested = false;
let authorizationState = "";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > MAX_INPUT_LINE) {
    send({ type: "fatal", code: "input_too_large" });
    process.exitCode = 1;
    input.close();
    return;
  }
  try {
    handleInput(JSON.parse(line) as InputFrame);
  } catch {
    send({ type: "fatal", code: "invalid_input" });
    process.exitCode = 1;
    input.close();
  }
});

function handleInput(frame: InputFrame): void {
  if (frame.type === "init") {
    if (initialized) {
      throw new Error("duplicate initialization");
    }
    initialized = true;
    startClient(frame);
    return;
  }
  if (!initialized || !sendRequest || clientId === undefined) {
    throw new Error("client is not initialized");
  }
  if (frame.type === "close" || frame.type === "logout") {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    sendRequest(clientId, JSON.stringify({ "@type": frame.type === "logout" ? "logOut" : "close" }));
    return;
  }
  if (frame.type !== "request" || !frame.id || pending.has(frame.id)) {
    throw new Error("invalid request");
  }
  const requestType = frame.request["@type"];
  if (typeof requestType !== "string" || !requestType) {
    throw new Error("request type is required");
  }
  pending.add(frame.id);
  sendRequest(
    clientId,
    JSON.stringify({ ...frame.request, "@extra": frame.id }),
  );
}

function startClient(frame: InitFrame): void {
  const library = load(frame.nativeLibrary);
  const createClient = library.func("int td_create_client_id()");
  sendRequest = library.func("void td_send(int client_id, const char *request)");
  receiveUpdates = library.func("const char *td_receive(double timeout)");
  const createdClientId = createClient();
  clientId = createdClientId;
  receiveNext();
  sendRequest(createdClientId, JSON.stringify({ "@type": "getAuthorizationState" }));

  function initializeAuthorization(): void {
    if (authorizationState !== "authorizationStateWaitTdlibParameters") {
      return;
    }
    authorizationState = "authorizationStateInitializing";
    sendRequest?.(
      clientId!,
      JSON.stringify({
        "@type": "setTdlibParameters",
        use_test_dc: false,
        database_directory: frame.databaseDirectory,
        files_directory: frame.filesDirectory,
        database_encryption_key: frame.databaseKey,
        use_file_database: false,
        use_chat_info_database: true,
        use_message_database: true,
        use_secret_chats: false,
        api_id: frame.apiId,
        api_hash: frame.apiHash,
        system_language_code: "en",
        device_model: "Regenic Telegram Connector",
        system_version: process.platform,
        application_version: "0.1.0",
      }),
    );
  }

  function receiveNext(): void {
    receiveUpdates?.async(0.25, (error, raw) => {
      if (error) {
        send({ type: "fatal", code: "tdlib_receive_failed" });
        process.exitCode = 1;
        input.close();
        return;
      }
      if (raw) {
        consume(raw);
      }
      if (authorizationState === "authorizationStateClosed") {
        send({ type: "closed" });
        input.close();
        process.stdin.pause();
        return;
      }
      receiveNext();
    });
  }

  function consume(raw: string): void {
    let update: Record<string, unknown>;
    try {
      update = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      send({ type: "fatal", code: "tdlib_invalid_json" });
      process.exitCode = 1;
      input.close();
      return;
    }

    const extra = update["@extra"];
    if (typeof extra === "string" && pending.has(extra)) {
      pending.delete(extra);
      if (update["@type"] === "error") {
        send({
          type: "response",
          id: extra,
          error: {
            code: typeof update.code === "number" ? update.code : 500,
          },
        });
      } else {
        send({ type: "response", id: extra, value: update });
      }
      return;
    }

    if (update["@type"] === "updateAuthorizationState") {
      const state = update.authorization_state;
      const nextState =
        state && typeof state === "object" && "@type" in state
          ? (state as { "@type"?: unknown })["@type"]
          : undefined;
      if (typeof nextState === "string") {
        authorizationState = nextState;
        send({ type: "authorization", state: nextState });
        initializeAuthorization();
      }
      return;
    }

    if (update["@type"] === "updateNewChat") {
      const chat = update.chat;
      if (chat && typeof chat === "object") {
        const value = chat as Record<string, unknown>;
        const type = value.type;
        const kind =
          type && typeof type === "object" && "@type" in type
            ? (type as { "@type"?: unknown })["@type"]
            : undefined;
        if (
          typeof value.id === "number" &&
          typeof value.title === "string" &&
          typeof kind === "string"
        ) {
          send({ type: "chat", id: value.id, title: value.title, kind });
        }
      }
      return;
    }

    if (update["@type"] === "updateChatTitle") {
      if (typeof update.chat_id === "number" && typeof update.title === "string") {
        send({
          type: "chat",
          id: update.chat_id,
          title: update.title,
          kind: "unknown",
        });
      }
      return;
    }

    if (update["@type"] === "updateMessageSendSucceeded") {
      const message = update.message;
      if (
        message &&
        typeof message === "object" &&
        typeof (message as Record<string, unknown>).id === "number" &&
        typeof update.old_message_id === "number"
      ) {
        send({
          type: "send_succeeded",
          temporaryId: update.old_message_id,
          messageId: (message as Record<string, unknown>).id,
        });
      }
      return;
    }

    if (update["@type"] === "updateMessageSendFailed") {
      const failed = update.message;
      const error = update.error;
      if (
        failed &&
        typeof failed === "object" &&
        typeof (failed as Record<string, unknown>).id === "number" &&
        typeof update.old_message_id === "number"
      ) {
        send({
          type: "send_failed",
          temporaryId: update.old_message_id,
          messageId: (failed as Record<string, unknown>).id,
          errorCode:
            error &&
            typeof error === "object" &&
            typeof (error as Record<string, unknown>).code === "number"
              ? (error as Record<string, number>).code
              : 500,
        });
      }
      return;
    }
  }
}

function send(value: Record<string, unknown>): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_OUTPUT_LINE) {
    const fallback = `${JSON.stringify({ type: "fatal", code: "output_too_large" })}\n`;
    process.stdout.write(fallback);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(line);
}
