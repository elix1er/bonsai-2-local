import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:5187",
    browserName: "chromium",
    launchOptions: {
      args: [
        "--host-resolver-rules=MAP bonsai.test 127.0.0.1",
        "--no-proxy-server",
      ],
    },
  },
  webServer: {
    command: "bun server.ts --port 5187",
    url: "http://127.0.0.1:5187",
    reuseExistingServer: false,
  },
});
