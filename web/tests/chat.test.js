import { test } from "node:test";
import assert from "node:assert/strict";
import { contextUsage, requestChat } from "../chat.js";
import { clearSession, loadSession, saveSession } from "../session.js";

test("context estimates reserve the chosen output allowance", () => {
  assert.equal(contextUsage([], false).total, 4096);
  assert.equal(contextUsage([], true).total, 8192);
  assert.equal(
    contextUsage([{ content: "x".repeat(100000) }], false).overLimit,
    true,
  );
});

test("saved sessions reject malformed histories and unavailable storage", () => {
  let value = null;
  const storage = {
    getItem: () => value,
    setItem: (_, data) => {
      value = data;
    },
    removeItem: () => {
      value = null;
    },
  };
  const session = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", finish: "stop" },
    ],
    draft: "next",
    thinking: true,
  };
  assert.equal(saveSession(session, storage), true);
  assert.deepEqual(loadSession(storage), {
    ...session,
    messages: [session.messages[0], { ...session.messages[1], thought: "" }],
    retryText: "",
  });
  value = JSON.stringify({
    ...session,
    messages: [{ role: "system", content: "bad" }],
  });
  assert.equal(loadSession(storage), null);
  value = "{";
  assert.equal(loadSession(storage), null);
  assert.equal(clearSession(storage), true);
  assert.equal(value, null);
  const unavailable = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
    removeItem() {
      throw Error();
    },
  };
  assert.equal(loadSession(unavailable), null);
  assert.equal(saveSession(session, unavailable), false);
  assert.equal(clearSession(unavailable), false);
});

test("SSE separators and split multibyte text preserve every event", async (t) => {
  for (const separator of ["\n\n", "\r\n\r\n", "\r\n\n", "\n\r\n"]) {
    await t.test(JSON.stringify(separator), async () => {
      const payload = new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "木" } }] })}${separator}data: ${JSON.stringify({ choices: [{ delta: { content: " second" }, finish_reason: "stop" }] })}${separator}data: [DONE]${separator}`,
      );
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of payload)
                  controller.enqueue(new Uint8Array([byte]));
                controller.close();
              },
            }),
          ),
      );
      let content = "";
      await requestChat([], {
        stream: true,
        thinking: false,
        onChunk: (chunk) => {
          content += chunk.content || "";
        },
      });
      assert.equal(content, "木 second");
      t.mock.restoreAll();
    });
  }
});

test("JSON replies preserve reasoning, finish reason, metrics, and request controls", async (t) => {
  let request;
  const result = {
    choices: [
      {
        message: { content: "answer", reasoning_content: "thought" },
        finish_reason: "length",
      },
    ],
    usage: { completion_tokens: 4 },
  };
  t.mock.method(globalThis, "fetch", async (_, options) => {
    request = JSON.parse(options.body);
    return Response.json(result);
  });
  let chunk;
  await requestChat([{ role: "user", content: "question" }], {
    stream: false,
    thinking: true,
    onChunk: (value) => {
      chunk = value;
    },
  });
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.chat_template_kwargs.enable_thinking, true);
  assert.equal(chunk.content, "answer");
  assert.equal(chunk.reasoning_content, "thought");
  assert.equal(chunk.finish, "length");
  assert.deepEqual(chunk.usage, result.usage);
});

test("truncated, malformed, and server-error replies fail explicitly", async (t) => {
  for (const payload of [
    "data: [DONE]\n\n",
    "data: broken\n\n",
    'data: {"error":{"message":"bad"}}\n\n',
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(payload));
    await assert.rejects(requestChat([], { stream: true, onChunk() {} }));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "offline" } }, { status: 503 }),
  );
  await assert.rejects(
    requestChat([], { stream: false, onChunk() {} }),
    /offline/,
  );
});

test("DONE cancels an open reader rather than waiting forever for EOF", async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await requestChat([], { stream: true, onChunk() {} });
  assert.equal(cancelled, true);
});
