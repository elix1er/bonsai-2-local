import { defineConfig } from "vite";

export default defineConfig({
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
