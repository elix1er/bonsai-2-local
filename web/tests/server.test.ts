import { test, afterEach, vi, onTestFinished } from "vitest";
afterEach(() => vi.restoreAllMocks());
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createChatServer } from "../server.ts";
import { createJobs } from "../jobs.ts";

/** Use an ephemeral localhost port so server fixtures cannot collide with live services. */
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

/** Close pooled connections as well as the listener during fixture cleanup. */
function close(server: http.Server) {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  return closed;
}

test("built assets and the two API routes work without exposing repository files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bonsai-web-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<h1>chat</h1>");
  await writeFile(path.join(root, "assets/app.js"), "app");
  let posted;
  const model = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end('{"status":"ok"}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    posted = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    res.end(
      '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}',
    );
  });
  const server = createChatServer({ root, modelPort: await listen(model) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    await close(server);
    await close(model);
    await rm(root, { recursive: true });
  });
  assert.equal(await (await fetch(base)).text(), "<h1>chat</h1>");
  const asset = await fetch(`${base}/assets/app.js`);
  assert.match(asset.headers.get("cache-control") || "", /immutable/);
  assert.equal(await asset.text(), "app");
  assert.equal(
    (await fetch(base, { method: "HEAD" })).headers.get("content-length"),
    "13",
  );
  for (const url of [
    "/server.ts",
    "/api/v1/models",
    "/%2e%2e%2fREADME.md",
    "/%00.ts",
  ]) {
    assert.equal(
      (await fetch(base + url)).status,
      url.includes("%00") ? 400 : 404,
    );
  }
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(
    (await fetch(`${base}/api/health`, { method: "POST" })).status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/api/v1/chat/completions`, { method: "POST" })).status,
    415,
  );
  const response = await fetch(`${base}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"stream":false}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(posted, { stream: false });
  assert.equal((await response.json()).choices[0].message.content, "ok");
});

test("offline model gets a useful JSON error", async () => {
  const unavailable = http.createServer();
  const modelPort = await listen(unavailable);
  await close(unavailable);
  const server = createChatServer({ modelPort });
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(() => close(server));
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Start the model/);
});

test("disconnecting a streaming client closes the model request", async () => {
  const { promise: stopped, resolve: disconnected } =
    Promise.withResolvers<void>();
  const model = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[]}\n\n');
    res.on("close", disconnected);
  });
  const server = createChatServer({ modelPort: await listen(model) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    await close(server);
    await close(model);
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/v1/chat/completions`, {
    signal: controller.signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.ok(response.body);
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([
    stopped,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Upstream did not stop")),
        2000,
      );
      timer.unref();
    }),
  ]);
});

test("remote jobs acknowledge promptly, stay pollable, reject overlap, and cancel model work", async () => {
  let finish: (() => void) | undefined;
  let call = 0;
  const { promise: secondStarted, resolve: secondSubmitted } =
    Promise.withResolvers<void>();
  const { promise: started, resolve: submitted } =
    Promise.withResolvers<void>();
  const { promise: stopped, resolve: disconnected } =
    Promise.withResolvers<void>();
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.stream, false);
    assert.equal(request.id, undefined);
    call++;
    if (call === 2) {
      secondSubmitted();
      res.on("close", disconnected);
    }
    finish = () =>
      res.end(
        '{"choices":[{"message":{"content":"remote"},"finish_reason":"stop"}]}',
      );
    submitted();
  });
  const server = createChatServer({ modelPort: await listen(model) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    await close(server);
    await close(model);
  });
  /** Submit a fixture job while keeping live model services out of the test. */
  const post = () =>
    fetch(`${base}/api/chat/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomBytes(16).toString("hex"),
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
  const first = await post();
  assert.equal(first.status, 202);
  const { id } = await first.json();
  await started;
  const url = `${base}/api/chat/jobs/${id}`;
  assert.equal((await (await fetch(url)).json()).state, "pending");
  assert.equal((await post()).status, 429);
  assert.ok(finish);
  finish();
  let job;
  for (let attempt = 0; attempt < 20; attempt++) {
    job = await (await fetch(url)).json();
    if (job.state === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.result.choices[0].message.content, "remote");
  assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(url)).status, 404);
  const second = await (await post()).json();
  await secondStarted;
  assert.equal(
    (await fetch(`${base}/api/chat/jobs/${second.id}`, { method: "DELETE" }))
      .status,
    204,
  );
  await Promise.race([
    stopped,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Remote model did not stop")),
        2000,
      );
      timer.unref();
    }),
  ]);
});

test("remote jobs validate IDs, stop at their deadline, and expire completed state", async () => {
  const model = http.createServer((req) => req.resume());
  const jobs = createJobs({
    modelPort: await listen(model),
    deadlineMs: 100,
    retentionMs: 1000,
  });
  const server = http.createServer((req, res) =>
    jobs.handle(req, res, req.url || "/"),
  );
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    jobs.close();
    await close(server);
    await close(model);
  });
  /** Submit a fixture job while keeping live model services out of the test. */
  const post = (id: string) =>
    fetch(`${base}/api/chat/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, messages: [{ role: "user", content: "hi" }] }),
    });
  assert.equal((await post("invalid")).status, 400);
  const id = randomBytes(16).toString("hex");
  assert.equal((await post(id)).status, 202);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = await (await fetch(`${base}/api/chat/jobs/${id}`)).json();
    if (job.state === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.state, "error");
  assert.match(job.error.message, /time limit/);
  let status;
  for (let attempt = 0; attempt < 150; attempt++) {
    status = (await fetch(`${base}/api/chat/jobs/${id}`)).status;
    if (status === 404) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status, 404);
});

test("remote jobs report the model status when its error body is not JSON", async () => {
  const model = http.createServer((req, res) => {
    req.resume();
    res.writeHead(503).end("temporarily unavailable");
  });
  const server = createChatServer({ modelPort: await listen(model) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    await close(server);
    await close(model);
  });
  const id = randomBytes(16).toString("hex");
  await fetch(`${base}/api/chat/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, messages: [{ role: "user", content: "hi" }] }),
  });
  let job;
  for (let attempt = 0; attempt < 20; attempt++) {
    job = await (await fetch(`${base}/api/chat/jobs/${id}`)).json();
    if (job.state === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.error.message, "Model request failed (503)");
});

test("an active poll renews a job lease and an abandoned job yields to a new request", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { promise: arrived, resolve: started } = Promise.withResolvers<void>();
  const { promise: cancelled, resolve: stopped } =
    Promise.withResolvers<void>();
  let calls = 0;
  const model = http.createServer((req, res) => {
    req.resume();
    if (++calls === 1) {
      res.on("close", stopped);
      started();
    }
  });
  const jobs = createJobs({ modelPort: await listen(model) });
  const server = http.createServer((req, res) =>
    jobs.handle(req, res, req.url || "/"),
  );
  const base = `http://127.0.0.1:${await listen(server)}`;
  onTestFinished(async () => {
    jobs.close();
    await close(server);
    await close(model);
  });
  /** Submit a fixture job while keeping live model services out of the test. */
  const post = (id: string) =>
    fetch(`${base}/api/chat/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, messages: [{ role: "user", content: "hi" }] }),
    });
  const first = randomBytes(16).toString("hex");
  assert.equal((await post(first)).status, 202);
  await arrived;
  now = 179_000;
  await fetch(`${base}/api/chat/jobs/${first}`);
  now = 358_000;
  assert.equal((await post(randomBytes(16).toString("hex"))).status, 429);
  now = 539_000;
  const second = randomBytes(16).toString("hex");
  assert.equal((await post(second)).status, 202);
  await cancelled;
  const old = await (await fetch(`${base}/api/chat/jobs/${first}`)).json();
  assert.equal(old.state, "error");
  assert.match(old.error.message, /stopped checking/);
  assert.equal(
    (await (await fetch(`${base}/api/chat/jobs/${second}`)).json()).state,
    "pending",
  );
});
