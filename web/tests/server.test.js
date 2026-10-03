import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createChatServer } from "../server.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test("built assets and the two API routes work without exposing repository files", async (t) => {
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
  t.after(async () => {
    await close(server);
    await close(model);
    await rm(root, { recursive: true });
  });
  assert.equal(await (await fetch(base)).text(), "<h1>chat</h1>");
  const asset = await fetch(`${base}/assets/app.js`);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal(await asset.text(), "app");
  assert.equal(
    (await fetch(base, { method: "HEAD" })).headers.get("content-length"),
    "13",
  );
  for (const url of [
    "/server.js",
    "/api/v1/models",
    "/%2e%2e%2fREADME.md",
    "/%00.js",
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

test("offline model gets a useful JSON error", async (t) => {
  const unavailable = http.createServer();
  const modelPort = await listen(unavailable);
  await close(unavailable);
  const server = createChatServer({ modelPort });
  const base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Start the model/);
});

test("disconnecting a streaming client closes the model request", async (t) => {
  let disconnected;
  const stopped = new Promise((resolve) => {
    disconnected = resolve;
  });
  const model = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[]}\n\n');
    res.on("close", disconnected);
  });
  const server = createChatServer({ modelPort: await listen(model) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  t.after(async () => {
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
