import { defineConfig } from "vite";
import { createChatApp } from "./server.ts";

export default defineConfig({
  plugins: [
    {
      name: "bonsai-api",
      configureServer(server) {
        const app = createChatApp();
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/api/")) return next();
          app.handle(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500).end();
            else res.destroy();
          });
        });
        server.httpServer?.on("close", app.close);
      },
    },
  ],
});
