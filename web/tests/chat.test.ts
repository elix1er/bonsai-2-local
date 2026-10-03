import * as v from "valibot";
import { requestSchema, type Session, type Chunk } from "../contracts.ts";
import { test, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { contextUsage, requestChat } from "../chat.ts";
import { clearSession, loadSession, saveSession } from "../session.ts";

afterEach(() => vi.restoreAllMocks());

test("legacy sessions survive invalid optional metrics without weakening history validation", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "answer",
      thought: "thought",
      finish: "stop",
    },
  ];
  for (const metric of ["n/a", true, 42, null, [1, 2]]) {
    values.set(
      "bonsai-chat-v1",
      JSON.stringify({
        messages: [
          messages[0],
          {
            ...messages[1],
            timings: metric,
            usage: { completion_tokens: 4, invalid: "n/a" },
          },
        ],
        draft: "next",
        thinking: true,
        retryText: "retry",
      }),
    );
    const saved = loadSession(storage);
    assert.ok(saved);
    assert.equal(saved.draft, "next");
    assert.equal(saved.thinking, true);
    assert.equal(saved.retryText, "retry");
    assert.equal(saved.messages[1].content, "answer");
    assert.equal(saved.messages[1].thought, "thought");
    assert.equal(saved.messages[1].timings, undefined);
    assert.deepEqual(saved.messages[1].usage, { completion_tokens: 4 });
    values.set(
      "bonsai-chat-v1",
      JSON.stringify({
        messages: [
          messages[0],
          { ...messages[1], timings: { predicted_n: 4 }, usage: metric },
        ],
        draft: "",
      }),
    );
    assert.deepEqual(loadSession(storage)?.messages[1].timings, {
      predicted_n: 4,
    });
    assert.equal(loadSession(storage)?.messages[1].usage, undefined);
  }
  values.set(
    "bonsai-chat-v1",
    JSON.stringify({
      messages: [messages[0], { ...messages[1], content: 42, timings: "n/a" }],
      draft: "",
    }),
  );
  assert.equal(loadSession(storage), null);
});

test("context estimates reserve the chosen output allowance", () => {
  assert.equal(contextUsage([], false).total, 4096);
  assert.equal(contextUsage([], true).total, 8192);
  assert.equal(
    contextUsage([{ content: "x".repeat(100000) }], false).overLimit,
    true,
  );
});

test("saved sessions reject malformed histories and unavailable storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const session: Session = {
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
  values.set(
    "bonsai-chat-v1",
    JSON.stringify({
      ...session,
      messages: [{ role: "system", content: "bad" }],
    }),
  );
  assert.equal(loadSession(storage), null);
  values.set("bonsai-chat-v1", "{");
  assert.equal(loadSession(storage), null);
  assert.equal(clearSession(storage), true);
  assert.equal(values.get("bonsai-chat-v1"), undefined);
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

test("SSE separators and split multibyte text preserve every event", async () => {
  for (const separator of ["\n\n", "\r\n\r\n", "\r\n\n", "\n\r\n"]) {
    const payload = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "木" } }] })}${separator}data: ${JSON.stringify({ choices: [{ delta: { content: " second" }, finish_reason: "stop" }] })}${separator}data: [DONE]${separator}`,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
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
    vi.restoreAllMocks();
  }
});

test("JSON replies preserve reasoning, finish reason, metrics, and request controls", async () => {
  let request: v.InferOutput<typeof requestSchema> | undefined;
  const result = {
    choices: [
      {
        message: { content: "answer", reasoning_content: "thought" },
        finish_reason: "length",
      },
    ],
    usage: { completion_tokens: 4 },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, options = {}) => {
    if (options.method === "POST") {
      request = v.parse(requestSchema, JSON.parse(String(options.body)));
      return Response.json(
        { id: "00000000000000000000000000000001" },
        { status: 202 },
      );
    }
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ state: "done", result });
  });
  let chunk: Chunk | undefined;
  await requestChat([{ role: "user", content: "question" }], {
    stream: false,
    thinking: true,
    onChunk: (value) => {
      chunk = value;
    },
  });
  assert.ok(request);
  assert.ok(chunk);
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.chat_template_kwargs?.enable_thinking, true);
  assert.equal(chunk.content, "answer");
  assert.equal(chunk.reasoning_content, "thought");
  assert.equal(chunk.finish, "length");
  assert.deepEqual(chunk.usage, result.usage);
});

test("truncated, malformed, and server-error replies fail explicitly", async () => {
  for (const payload of [
    "data: [DONE]\n\n",
    "data: broken\n\n",
    'data: {"error":{"message":"bad"}}\n\n',
  ]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(payload),
    );
    await assert.rejects(requestChat([], { stream: true, onChunk() {} }));
    vi.restoreAllMocks();
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "offline" } }, { status: 503 }),
  );
  await assert.rejects(
    requestChat([], { stream: false, onChunk() {} }),
    /offline/,
  );
});

test("DONE cancels an open reader rather than waiting forever for EOF", async () => {
  let cancelled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(
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

test("remote polling survives a network failure and a non-JSON gateway response", async () => {
  let polls = 0;
  let deleted = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, options = {}) => {
    if (options.method === "POST")
      return Response.json(
        { id: JSON.parse(String(options.body)).id },
        { status: 202 },
      );
    if (options.method === "DELETE") {
      deleted++;
      return new Response(null, { status: 204 });
    }
    polls++;
    if (polls === 1) throw new TypeError("Network unavailable");
    if (polls === 2)
      return new Response("<h1>Bad gateway</h1>", { status: 502 });
    return Response.json({
      state: "done",
      result: {
        choices: [{ message: { content: "Recovered" }, finish_reason: "stop" }],
      },
    });
  });
  let content;
  await requestChat([{ role: "user", content: "hi" }], {
    stream: false,
    onChunk: (chunk) => {
      content = chunk.content;
    },
  });
  assert.equal(content, "Recovered");
  assert.equal(polls, 3);
  assert.equal(deleted, 1);
});

test("remote polling stops on expiry and bounds consecutive gateway failures", async () => {
  for (const status of [404, 502]) {
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_, options = {}) => {
        if (options.method === "POST")
          return Response.json({ id: JSON.parse(String(options.body)).id });
        if (options.method === "DELETE")
          return new Response(null, { status: 204 });
        polls++;
        return new Response("unavailable", { status });
      },
    );
    await assert.rejects(
      requestChat([{ role: "user", content: "hi" }], {
        stream: false,
        onChunk() {},
      }),
      (error) =>
        error instanceof Error && "status" in error && error.status === status,
    );
    assert.equal(polls, status === 404 ? 1 : 3);
    vi.restoreAllMocks();
  }
});
