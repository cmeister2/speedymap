import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 180_000,
  expect: { timeout: 120_000 },
  workers: 1,
  use: {
    baseURL: "http://localhost:4173/speedymap/",
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  },
  webServer: {
    command:
      "npm run build && npm run preview -- --port 4173 --base=/speedymap/",
    url: "http://localhost:4173/speedymap/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
