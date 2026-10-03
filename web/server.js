import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function createChatServer({
  root = fileURLToPath(new URL("./dist/", import.meta.url)),
  modelPort = 8080,
} = {}) {
  root = path.resolve(root);

  /** Proxy only the model routes used by chat, and cancel work when the client leaves. */
  function proxy(req, res, pathname) {
    const expectedMethod = pathname === "/api/health" ? "GET" : "POST";
    if (req.method !== expectedMethod) {
      res.writeHead(405, { Allow: expectedMethod }).end();
      return;
    }
    if (
      expectedMethod === "POST" &&
      !String(req.headers["content-type"]).startsWith("application/json")
    ) {
      res.writeHead(415).end();
      return;
    }
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: modelPort,
        path: pathname.slice(4),
        method: req.method,
        headers:
          expectedMethod === "POST"
            ? { "Content-Type": "application/json" }
            : {},
      },
      (response) => {
        res.writeHead(response.statusCode, {
          "Content-Type":
            response.headers["content-type"] || "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.pipe(res);
        response.on("error", () => res.destroy());
      },
    );
    res.on("close", () => upstream.destroy());
    req.on("aborted", () => upstream.destroy());
    upstream.on("error", () => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Bonsai is offline. Start the model with ./start.sh, then retry.",
          },
        }),
      );
    });
    req.pipe(upstream);
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.includes("\0")) {
      res.writeHead(400).end();
      return;
    }
    if (["/api/health", "/api/v1/chat/completions"].includes(pathname)) {
      proxy(req, res, pathname);
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const file = path.resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(`${root}${path.sep}`) || !types[path.extname(file)]) {
      res.writeHead(404).end();
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)],
        "Content-Length": info.size,
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      if (req.method === "HEAD") res.end();
      else await pipeline(createReadStream(file), res);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else res.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  server.requestTimeout = 300000;
  server.timeout = 0;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf("--port");
  const port = Number(portIndex < 0 ? 5173 : process.argv[portIndex + 1]);
  const server = createChatServer();
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Bonsai chat: http://127.0.0.1:${server.address().port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
