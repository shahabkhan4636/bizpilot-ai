import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite. Runs against a real dev server and a dedicated database
 * (data/e2e.db) so it never touches development data.
 *
 *   npm run test:e2e
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Tests run against a production build: dev-mode first-compile times make
    // assertions flaky and don't represent what users get.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 420_000,
    env: {
      // Postgres mode: set DATABASE_URL (and BIZPILOT_ENGINE=postgres) in the
      // shell before `npx playwright test` and the whole suite runs against the
      // real database instead of the SQLite file.
      ...(process.env.DATABASE_URL ? {} : { BIZPILOT_DB_FILE: "data/e2e.db" }),
      // The suite signs up one workspace per scenario, all from 127.0.0.1, so the
      // production signup/login ceilings (10/hour, 20/10min per IP) would throttle
      // the tests themselves. Raised here only — the app defaults are unchanged.
      SIGNUP_RATE_LIMIT: "1000",
      LOGIN_RATE_LIMIT: "1000",
      NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${PORT}`,
      // A test-only gateway secret so the real webhook route can be exercised end
      // to end (signature → approval → plan). Production uses the real merchant one.
      SADAPAY_WEBHOOK_SECRET: "e2e_sadapay_webhook_secret",
    },
  },
});
