import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 1 — the /admin area is gated server-side and answers **404** to anyone who
 * is not the platform owner.
 *
 * 404 and not 403/redirect on purpose: a redirect to `/dashboard?error=forbidden`
 * tells a stranger that an admin area exists and where it lives. The owner address
 * is `ADMIN_EMAIL`, handed to the test server by playwright.config.ts — nothing is
 * hardcoded in the app.
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "owner@bizpilot.test";
const stamp = Date.now();

const owner = {
  email: ADMIN_EMAIL,
  password: "TestingPass123",
  name: "Shahab Khan",
  company: `Platform ${stamp}`,
};

const stranger = {
  email: `stranger.${stamp}@example.com`,
  password: "TestingPass123",
  name: "Not The Owner",
  company: `Stranger ${stamp}`,
};

type TestUser = { email: string; password: string; name: string; company: string };

/**
 * Order-independent account setup.
 *
 * The owner's address must equal `ADMIN_EMAIL`, so — unlike every other spec — it
 * cannot carry a timestamp to stay unique. Playwright may run this file before or
 * after the main suite (which truncates the database), so the first thing to do is
 * try to sign in, and only sign up when the account genuinely does not exist yet.
 */
async function ensureUser(page: Page, user: TestUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL("**/dashboard", { timeout: 8_000 });
    return;
  } catch {
    // Not created yet (or the credentials are new): fall through to signup.
  }
  await signup(page, user);
}

async function signup(page: Page, user: TestUser) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(user.name);
  await page.getByLabel("Company name").fill(user.company);
  await page.getByLabel("Work email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/onboarding", { timeout: 30_000 });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("a non-admin user gets a 404 on /admin, not a redirect", async ({ page }) => {
  await ensureUser(page, stranger);

  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
  // The 404 page must not leak the panel's own words back to the visitor.
  await expect(page.getByRole("heading", { name: "Admin panel" })).toHaveCount(0);
  await expect(page.getByText("Integration status")).toHaveCount(0);

  // Still signed in and still a normal user: /dashboard works.
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /Good to see you/i }).first()).toBeVisible({ timeout: 20_000 });
});

test("the ADMIN_EMAIL user gets a 200 on /admin", async ({ page }) => {
  await ensureUser(page, owner);

  const response = await page.goto("/admin");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Admin panel" })).toBeVisible({ timeout: 20_000 });
  // The admin link is offered in the shell for the owner, and not for strangers
  // (asserted above by the 404).
  await expect(page.getByText("Integration status")).toBeVisible();
});

test("the owner is identified by the env var, so the same person keeps access after logout", async ({ page }) => {
  // Signing in again must re-derive admin access from ADMIN_EMAIL rather than from a
  // lucky session: same 200, same panel.
  await page.goto("/login");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });

  const response = await page.goto("/admin");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Admin panel" })).toBeVisible({ timeout: 20_000 });
});
