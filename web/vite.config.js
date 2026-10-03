import { defineConfig } from "vite";
import { createJobs, isJobPath } from "./jobs.js";

export default defineConfig({
  plugins: [
    {
      name: "remote-chat-jobs",
      configureServer(server) {
        const jobs = createJobs({ modelPort: 8080 });
        server.middlewares.use((req, res, next) => {
          const pathname = new URL(req.url, "http://localhost").pathname;
          if (!isJobPath(pathname)) {
            next();
            return;
          }
          jobs.handle(req, res, pathname).catch(() => {
            if (!res.headersSent) res.writeHead(500).end();
          });
        });
        server.httpServer?.on("close", () => jobs.close());
      },
    },
  ],
  server: {
    proxy: {
      "^/api/(health|v1/chat/completions)$": {
        target: "http://127.0.0.1:8080",
        rewrite: (path) => path.replace(/^\/api/, ""),
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        headers: {
          Connection: "keep-alive",
        },
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            req.socket.setTimeout(0);
            if (proxyReq.socket) {
              proxyReq.socket.setTimeout(0);
            }
          });
          proxy.on("proxyRes", (proxyRes, req, res) => {
            res.socket.setTimeout(0);
          });
          proxy.on("error", (err, req, res) => {
            console.error("[vite-proxy-error]", err.message);
          });
        },
      },
    },
  },
});
