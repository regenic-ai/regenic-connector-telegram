const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const load = async () => ({
  contract: await import("@regenic/connector-contract"),
  testUtils: await import("@regenic/connector-test-utils"),
  messages: await import("../dist/telegram-message.js"),
  poll: await import("../dist/telegram-poll.js"),
  driver: await import("../dist/telegram-driver.js"),
  egress: await import("../dist/telegram-egress.js"),
  keyring: await import("../dist/keyring.js"),
  outbox: await import("../dist/outbox.js"),
  runtime: await import("../dist/runtime.js"),
});

function message(id, text = `message ${id}`) {
  return {
    id,
    date: 1_700_000_000 + id,
    is_outgoing: false,
    sender_id: { "@type": "messageSenderUser", user_id: 55 },
    content: {
      "@type": "messageText",
      text: { "@type": "formattedText", text, entities: [] },
    },
  };
}

function fakeRuntime(client) {
  return {
    async withClient(_installation, operation) {
      return operation(client, new AbortController().signal);
    },
  };
}

function fakeClient(historyPages = []) {
  let lastHistoryPage = [];
  return {
    chats: new Map(),
    async request(type, parameters) {
      if (type === "getChat") {
        return {
          id: parameters.chat_id,
          title: `Chat ${parameters.chat_id}`,
          type: { "@type": "chatTypePrivate" },
        };
      }
      if (type === "getChatHistory") {
        if (historyPages.length > 0) {
          lastHistoryPage = historyPages.shift();
        }
        return { messages: lastHistoryPage };
      }
      throw new Error(`Unexpected TDLib request: ${type}`);
    },
  };
}

const installation = {
  id: "telegram-install",
  org_id: "org-1",
  connector_type: "telegram-user",
  status: "enabled",
  config: { profile_id: "test-profile", chat_ids: ["12345"] },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

test("driver and poll batch satisfy the published contract conformance helpers", async () => {
  const { testUtils, driver, poll } = await load();
  const instance = driver.createTelegramDriver({
    runtime: fakeRuntime(fakeClient([[]])),
    keyring: {},
  });
  testUtils.verifyConnectorSourceMode({
    source_mode: instance.source_mode,
    poll: async () => {
      throw new Error("not used");
    },
  });
  testUtils.verifyChannelDriverConformance({
    driver: instance,
    enabled: installation,
    disabled: { ...installation, status: "disabled" },
  });
  const connector = poll.createTelegramPollConnector({
    runtime: fakeRuntime(fakeClient([[message(9)]])),
    installation,
    chatId: "12345",
  });
  const report = await testUtils.verifyPollConnectorConformance({
    connector,
    cursor: null,
    connector_id: installation.id,
    source: "telegram",
  });
  assert.equal(report.record_count, 1);
});

test("published plugin host mounts selected Telegram streams and egress adapters", async () => {
  const [{ createHost }, { driver, poll }] = await Promise.all([
    import("@regenic/plugin-host"),
    load(),
  ]);
  const host = await createHost();
  const streams = new Map();
  const adapters = new Map();
  const connectors = {
    register(installationId, connector, binding) {
      const key = binding.stream_key;
      streams.set(`${installationId}:${key}`, {
        ...binding,
        connector,
      });
      return () => streams.delete(`${installationId}:${key}`);
    },
    getStream(installationId, key) {
      return streams.get(`${installationId}:${key}`);
    },
    listStreams(installationId) {
      return [...streams.entries()]
        .filter(([key]) => key.startsWith(`${installationId}:`))
        .map(([, stream]) => stream);
    },
  };
  const egress = {
    register(installationId, adapter, key) {
      adapters.set(`${installationId}:${key}`, adapter);
      return () => adapters.delete(`${installationId}:${key}`);
    },
    get(installationId, key) {
      return adapters.get(`${installationId}:${key}`);
    },
  };
  const removeConnectors = host.provide("connectors", connectors);
  const removeEgress = host.provide("egress", egress);
  const instance = driver.createTelegramDriver({
    runtime: fakeRuntime(fakeClient([[message(9)]])),
    keyring: {},
  });
  try {
    const mounted = await instance.resolveStreams(installation, host, process.env, {
      threads: [],
    });
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].stream_key, poll.telegramStreamKey("12345"));
    const batch = await mounted[0].connector.poll(null);
    assert.equal(batch.batch.records[0].external_id, "12345/9");
    const adapter = await instance.bindEgress(
      installation,
      { source: "telegram", target: poll.telegramThreadId("12345") },
      host,
      process.env,
    );
    assert.equal(adapter, egress.get(installation.id, poll.telegramStreamKey("12345")));
  } finally {
    removeEgress();
    removeConnectors();
    await host.dispose();
  }
});

test("Telegram message mapping preserves text identity, reply, direction, and edit version", async () => {
  const { messages } = await load();
  const source = message(42, "hello");
  source.is_outgoing = true;
  source.edit_date = 1_700_000_100;
  source.reply_to = {
    "@type": "messageReplyToMessage",
    message_id: 41,
  };
  const parsed = messages.telegramMessageRecord({
    chatId: "12345",
    chatName: "Example chat",
    message: source,
  });
  assert.equal(parsed.external_id, "12345/42");
  assert.equal(parsed.parent_external_id, "12345/41");
  assert.deepEqual(parsed.direction_tags, ["outbound"]);
  assert.equal(parsed.revision_id, "42:1700000100");
  assert.equal(parsed.content[0].text, "hello");
  assert.equal(
    messages.parseTelegramExternalId(parsed.external_id, "12345"),
    42,
  );
  assert.equal(
    messages.telegramMessageRecord({
      chatId: "12345",
      chatName: "Example chat",
      message: { ...source, content: { "@type": "messagePhoto" } },
    }),
    undefined,
  );
});

test("live incremental polling pages through gaps without replaying messages", async () => {
  const { poll } = await load();
  const pages = [
    Array.from({ length: 10 }, (_, index) => message(20 - index)),
    [11, 10, 9, 8].map((id) => message(id)),
    [8, 7, 6, 5].map((id) => message(id)),
  ];
  const connector = poll.createTelegramPollConnector({
    runtime: fakeRuntime(fakeClient(pages)),
    installation,
    chatId: "12345",
  });
  const cursor = { value: JSON.stringify({ version: 1, chat_id: "12345", last_message_id: 5 }) };
  const first = await connector.poll(cursor);
  assert.equal(first.has_more, true);
  assert.deepEqual(first.batch.records.map((record) => record.external_id), [
    "12345/11",
    "12345/12",
    "12345/13",
    "12345/14",
    "12345/15",
    "12345/16",
    "12345/17",
    "12345/18",
    "12345/19",
    "12345/20",
  ]);
  const secondCursor = { value: first.next_cursor };
  const second = await connector.poll(secondCursor);
  assert.deepEqual(second.batch.records.map((record) => record.external_id), [
    "12345/8",
    "12345/9",
    "12345/10",
  ]);
  const third = await connector.poll({ value: second.next_cursor });
  assert.equal(third.has_more, false);
  assert.deepEqual(third.batch.records.map((record) => record.external_id), [
    "12345/6",
    "12345/7",
  ]);
  const finalCursor = JSON.parse(third.next_cursor);
  assert.equal(finalCursor.last_message_id, 20);
  assert.equal(finalCursor.catchup_anchor_id, undefined);
});

test("directory pages include only explicitly selected conversations", async () => {
  const { poll } = await load();
  const chatIds = Array.from({ length: 205 }, (_, index) => String(10_000 + index));
  const runtime = {
    async withClient(_installation, operation) {
      const client = {
        async request(type, parameters) {
          assert.equal(type, "getChat");
          return {
            id: parameters.chat_id,
            title: `Chat ${parameters.chat_id}`,
            type: { "@type": "chatTypePrivate" },
          };
        },
      };
      return operation(client, new AbortController().signal);
    },
  };
  const source = poll.createTelegramSyncSource({
    runtime,
    installation,
    chatIds,
  });
  const first = await source.listDirectory(null);
  assert.equal(first.members.length, 100);
  assert.equal(first.replaces, true);
  assert.equal(first.complete, false);
  const second = await source.listDirectory(first.next_cursor);
  assert.equal(second.members.length, 100);
  const third = await source.listDirectory(second.next_cursor);
  assert.equal(third.members.length, 5);
  assert.equal(third.complete, true);
  assert.equal(new Set([...first.members, ...second.members, ...third.members].map((member) => member.thread_id)).size, 205);
});

test("encrypted outbox stores no message body or idempotency key in plaintext", async () => {
  const { outbox } = await load();
  const directory = await mkdtemp(join(tmpdir(), "regenic-telegram-outbox-"));
  const path = join(directory, "outbox.bin");
  const key = Buffer.alloc(32, 9);
  try {
    const journal = new outbox.FileEncryptedOutbox(path, "test-profile", key);
    assert.equal(
      await journal.begin({
        idempotencyKey: "private-idempotency-key",
        fingerprint: "a".repeat(64),
      }),
      undefined,
    );
    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from("private-idempotency-key")), false);
    assert.equal(bytes.includes(Buffer.from("a".repeat(64))), false);
    await journal.update("private-idempotency-key", "a".repeat(64), {
      state: "unknown",
    });
    assert.equal(
      (await journal.begin({
        idempotencyKey: "private-idempotency-key",
        fingerprint: "a".repeat(64),
      })).state,
      "unknown",
    );
    await assert.rejects(
      journal.update("private-idempotency-key", "a".repeat(64), {
        state: "unknown",
      }),
      /already in a final state/,
    );
    await assert.rejects(
      journal.begin({
        idempotencyKey: "private-idempotency-key",
        fingerprint: "b".repeat(64),
      }),
      /reused with different content/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid stored database keys fail closed without replacement", async () => {
  const { keyring } = await load();
  let writeCount = 0;
  const store = {
    async read() {
      return "invalid-key";
    },
    async write() {
      writeCount += 1;
    },
    async delete() {
      return false;
    },
  };
  await assert.rejects(
    keyring.getOrCreateDatabaseKey(store, "test-profile"),
    /invalid; refusing unencrypted fallback/,
  );
  assert.equal(writeCount, 0);
});

test("outbound accepted and unknown results are journaled and never blindly resent", async () => {
  const { egress } = await load();
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "regenic-telegram-home-"));
  const secrets = new Map([
    ["database-key", Buffer.alloc(32, 7).toString("base64")],
  ]);
  const keyring = {
    async read(_profile, name) {
      return secrets.get(name);
    },
    async write(_profile, name, value) {
      secrets.set(name, value);
    },
    async delete() {
      return true;
    },
  };
  let sendCount = 0;
  let waitFails = false;
  const sendRequests = [];
  const runtime = {
    async withClient(_installation, operation) {
      const client = {
        async request(type, parameters) {
          if (type === "getChat") {
            return {
              id: 12345,
              title: "Test conversation",
              type: { "@type": "chatTypePrivate" },
            };
          }
          assert.equal(type, "sendMessage");
          sendRequests.push(parameters);
          sendCount += 1;
          return { id: -sendCount };
        },
        async waitForSendUpdate(temporaryId) {
          if (waitFails) {
            throw new Error("timeout");
          }
          return { temporaryId, messageId: 50 + sendCount };
        },
      };
      return operation(client, new AbortController().signal);
    },
  };
  try {
    process.env.HOME = home;
    const accepted = new egress.TelegramEgress(runtime, keyring, installation, "12345");
    const intent = {
      installation_id: installation.id,
      target: { scope_id: "12345", external_id: "12345/49" },
      content: [{ role: "body", media_type: "text/plain", text: "hello" }],
      idempotency_key: "accepted-key",
    };
    const first = await accepted.send(intent);
    const replay = await accepted.send(intent);
    assert.equal(first.rpc_id, "12345/51");
    assert.deepEqual(replay, first);
    assert.equal(sendCount, 1);
    assert.deepEqual(sendRequests[0].reply_to, {
      "@type": "inputMessageReplyToMessage",
      message_id: 49,
      quote: null,
      checklist_task_id: 0,
      poll_option_id: "",
    });
    const journalBytes = await readFile(
      join(
        home,
        "Library",
        "Application Support",
        "Regenic",
        "Telegram",
        "test-profile",
        "outbox.bin",
      ),
    );
    assert.equal(journalBytes.includes(Buffer.from("hello")), false);

    waitFails = true;
    const uncertain = {
      ...intent,
      idempotency_key: "uncertain-key",
      content: [{ role: "body", media_type: "text/plain", text: "maybe sent" }],
    };
    await assert.rejects(accepted.send(uncertain), /outcome is unknown/);
    await assert.rejects(accepted.send(uncertain), /outcome is unknown/);
    assert.equal(sendCount, 2);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("installation stop aborts in-flight work, closes the client, and fences stale calls", async () => {
  const { runtime: runtimeModule } = await load();
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "regenic-telegram-runtime-"));
  let resolveEntered;
  const entered = new Promise((resolve) => {
    resolveEntered = resolve;
  });
  let openCount = 0;
  const closeSignals = [];
  const client = {
    async waitUntilReady() {},
    async close(signal) {
      closeSignals.push(signal);
    },
  };
  const runtime = new runtimeModule.TelegramRuntime({
    keyring: {},
    async openClient() {
      openCount += 1;
      return client;
    },
  });
  try {
    process.env.HOME = home;
    await runtime.startInstallation(installation);
    const operation = runtime.withClient(installation, async (_client, signal) => {
      resolveEntered();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw signal.reason;
    });
    await entered;
    await runtime.stopInstallation(installation, {}, {
      reason: "disable",
      signal: new AbortController().signal,
    });
    await assert.rejects(operation, /Telegram installation stopped/);
    assert.ok(closeSignals.length >= 1);
    assert.ok(closeSignals.every((signal) => !signal?.aborted));
    await assert.rejects(
      runtime.withClient(installation, async () => "stale"),
      /Telegram installation is not active/,
    );
    assert.equal(openCount, 1);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("stale profile lock recovery is serialized and removes its recovery marker", async () => {
  const { runtime: runtimeModule } = await load();
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "regenic-telegram-stale-lock-"));
  const profileDirectory = join(
    home,
    "Library",
    "Application Support",
    "Regenic",
    "Telegram",
    "test-profile",
  );
  const lockPath = join(profileDirectory, ".client.lock");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }),
    { mode: 0o600 },
  );
  const client = {
    async waitUntilReady() {},
    async close() {},
  };
  const runtime = new runtimeModule.TelegramRuntime({
    keyring: {},
    async openClient() {
      return client;
    },
  });
  try {
    process.env.HOME = home;
    await runtime.startInstallation(installation);
    assert.equal(
      await runtime.withClient(installation, async () => "recovered"),
      "recovered",
    );
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
    await assert.rejects(readFile(`${lockPath}.recovery`), { code: "ENOENT" });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
