import { defineConfig, devices } from "@playwright/test";

// Onboarding + AI-translate smoke suite. Separate from playwright.config.ts
// (the concurrency suite) on every axis that would otherwise collide if both
// ran at once: testDir, ports (api 8797 / web 5175 / stub 8799, vs. the
// concurrency suite's 8787/5173), and --persist-to (a distinct local D1, so
// this suite's empty-DB onboarding never touches the concurrency suite's
// seeded ZEC fixture or vice versa).
const BASE_URL = "http://localhost:5175";

export default defineConfig({
  testDir: "tests/smoke",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-smoke", open: "never" }]],
  timeout: 120_000,
  expect: { timeout: 5_000 },
  globalSetup: "./tests/smoke/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Stub translate upstream — reused across runs (reuseExistingServer)
      // since it holds no per-test state that needs a fresh process.
      command: "node scripts/translate-stub-server.mjs --port 8799",
      url: "http://127.0.0.1:8799/health",
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // api (wrangler) + web (vite), wired to the stub above via
      // PIPELINE_API_BASE/BT_API_TOKEN inside scripts/dev-smoke.mjs.
      command: "node scripts/dev-smoke.mjs",
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
