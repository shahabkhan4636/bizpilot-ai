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

test("the email outbox is admin-only and queues instead of lying when Resend is missing", async ({ browser }) => {
  // A stranger gets the same 404 as any other /admin route.
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await ensureUser(strangerPage, stranger);
  const blocked = await strangerPage.goto("/admin/email");
  expect(blocked?.status()).toBe(404);
  await strangerContext.close();

  // The owner sees the outbox, plus an honest "not configured" state.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);
  const page = await ownerPage.goto("/admin/email");
  expect(page?.status()).toBe(200);
  await expect(ownerPage.getByRole("heading", { name: "Email outbox" })).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByText(/Email is not configured on this deployment/)).toBeVisible();

  // A test send in this state must queue the message and say so — never claim it left.
  await ownerPage.getByRole("button", { name: /Queue test email/i }).click();
  await expect(ownerPage.getByText(/queued in the outbox/i)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByText(/Email is not configured on this deployment/)).toBeVisible();

  // And the queued row is visible with zero attempts burned.
  await expect(ownerPage.getByRole("heading", { name: "Queued" })).toBeVisible();
  await expect(ownerPage.getByText(owner.email).first()).toBeVisible();

  await ownerContext.close();
});

test("platform payments: owner configures payouts, a customer claims, the owner approves and the plan activates", async ({ browser }) => {
  // 1. A stranger gets a 404 on the queue — same rule as every other /admin route.
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await ensureUser(strangerPage, stranger);
  const blocked = await strangerPage.goto("/admin/platform-payments");
  expect(blocked?.status()).toBe(404);
  // ...and cannot see the platform's payout numbers anywhere.
  const billingBlocked = await strangerPage.goto("/billing/platform");
  expect(billingBlocked?.status()).toBe(200);

  // 2. The owner configures where money should land. Nothing is hardcoded in the app.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);
  const queue = await ownerPage.goto("/admin/platform-payments");
  expect(queue?.status()).toBe(200);
  await expect(ownerPage.getByRole("heading", { name: "Platform payments" })).toBeVisible({ timeout: 20_000 });

  await ownerPage.getByLabel("Account holder name").fill("Shahab Khan");
  await ownerPage.getByLabel("SadaPay number").fill("03001234567");
  await ownerPage.getByRole("button", { name: /Save payout settings/i }).click();
  await expect(ownerPage.getByText(/Payout settings saved/i)).toBeVisible({ timeout: 20_000 });

  // 3. The customer now sees those numbers and submits a claim.
  const reference = `E2E-${Date.now()}`;
  await strangerPage.goto("/billing/platform");
  await expect(strangerPage.getByText("03001234567")).toBeVisible({ timeout: 20_000 });
  await strangerPage.getByLabel("Transaction ID").fill(reference);
  await strangerPage.getByRole("button", { name: /Submit payment for approval/i }).click();
  await strangerPage.waitForURL("**/billing**", { timeout: 30_000 });

  // 4. The claim appears in the owner's queue with its transaction ID.
  await ownerPage.goto("/admin/platform-payments");
  await expect(ownerPage.getByText(reference)).toBeVisible({ timeout: 20_000 });
  await ownerPage.getByRole("button", { name: /^Approve Rs/i }).first().click();
  await ownerPage.waitForURL("**/admin/platform-payments?reviewed=approve", { timeout: 30_000 });
  await expect(ownerPage.getByText(/Claim approved/i)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByText("Nothing waiting")).toBeVisible();

  // 5. The customer's plan actually changed, and the Founding price was locked.
  await strangerPage.goto("/billing/platform");
  await expect(strangerPage.getByText(/Founding Member — your price is locked/i)).toBeVisible({ timeout: 20_000 });
  await expect(strangerPage.getByText(reference).first()).toBeVisible();
  await expect(strangerPage.getByText(/approved/i).first()).toBeVisible();

  await strangerContext.close();
  await ownerContext.close();
});

test("the platform owner's own workspace is unlimited and badged, and a customer's is not", async ({ browser }) => {
  // A customer workspace keeps the catalogue limits and shows no owner badge.
  const customerContext = await browser.newContext();
  const customerPage = await customerContext.newPage();
  await ensureUser(customerPage, stranger);
  await customerPage.goto("/dashboard");
  await expect(customerPage.getByTestId("platform-owner-badge")).toHaveCount(0);
  await customerPage.goto("/leads");
  await expect(customerPage.getByText(/Limit \d/).first()).toBeVisible({ timeout: 20_000 });
  await expect(customerPage.getByText(/Unlimited/)).toHaveCount(0);

  // The platform owner's workspace is unlimited and says so in plain words.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);
  await ownerPage.goto("/dashboard");
  await expect(ownerPage.getByTestId("platform-owner-badge")).toBeVisible({ timeout: 20_000 });
  await ownerPage.goto("/leads");
  await expect(ownerPage.getByText(/Limit Unlimited/).first()).toBeVisible({ timeout: 20_000 });
  await ownerPage.goto("/billing");
  await expect(ownerPage.getByText(/Unlimited/).first()).toBeVisible({ timeout: 20_000 });

  // ...and the admin workspace list marks it, so a never-billed workspace is visibly intentional.
  await ownerPage.goto("/admin");
  await expect(ownerPage.getByText("Platform owner").first()).toBeVisible({ timeout: 20_000 });

  await customerContext.close();
  await ownerContext.close();
});

/** Opens a customer workspace from the admin list, via search. */
async function openWorkspace(page: Page, query: string) {
  await page.goto("/admin/workspaces");
  await page.getByLabel("Search").fill(query);
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Open" }).first().click();
  await page.waitForURL(/\/admin\/workspaces\/[0-9a-f-]{8,}/, { timeout: 30_000 });
}

test("workspaces, users and payments are admin-only and list real data", async ({ browser }) => {
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await ensureUser(strangerPage, stranger);
  for (const path of ["/admin/workspaces", "/admin/users", "/admin/payments"]) {
    const response = await strangerPage.goto(path);
    expect(response?.status(), `${path} must 404 for a non-admin`).toBe(404);
  }
  await strangerContext.close();

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);

  expect((await ownerPage.goto("/admin/workspaces"))?.status()).toBe(200);
  await expect(ownerPage.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByText(stranger.company).first()).toBeVisible();
  // The platform owner's own workspace is marked, not billed.
  await expect(ownerPage.getByText("Platform owner").first()).toBeVisible();

  expect((await ownerPage.goto("/admin/users"))?.status()).toBe(200);
  await ownerPage.getByLabel("Search").fill(stranger.email);
  await ownerPage.getByRole("button", { name: "Search" }).click();
  await expect(ownerPage.getByText(stranger.email).first()).toBeVisible({ timeout: 20_000 });

  expect((await ownerPage.goto("/admin/payments"))?.status()).toBe(200);
  await expect(ownerPage.getByRole("heading", { name: "Payments", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: /Workspace payments/i })).toBeVisible();

  await ownerContext.close();
});

test("suspending a workspace needs a reason, blocks the customer, and restoring brings it back", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);
  await openWorkspace(ownerPage, stranger.company);

  // A reason is mandatory: submitting without one must not reach the server action.
  const reason = "Payment failed after 3 reminders (e2e)";
  await ownerPage.getByLabel(/Reason for suspending/i).fill(reason);
  await ownerPage.getByRole("button", { name: /Suspend workspace/i }).click();
  await ownerPage.waitForURL("**/admin/workspaces/**?done=suspended", { timeout: 30_000 });
  await expect(ownerPage.getByText(/Workspace suspended/i).first()).toBeVisible({ timeout: 20_000 });

  // The customer is locked out and told why — no 500, no silent redirect.
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await ensureUser(strangerPage, stranger);
  await strangerPage.goto("/leads");
  await strangerPage.waitForURL("**/suspended", { timeout: 30_000 });
  await expect(strangerPage.getByRole("heading", { name: /workspace is suspended/i })).toBeVisible();
  await expect(strangerPage.getByText(reason)).toBeVisible();

  // Restore, and the customer is immediately back.
  await ownerPage.goto(ownerPage.url());
  await ownerPage.getByLabel(/Reason for restoring/i).fill("Invoice paid — access restored (e2e)");
  await ownerPage.getByRole("button", { name: /Restore workspace/i }).click();
  await ownerPage.waitForURL("**?done=restored", { timeout: 30_000 });
  await expect(ownerPage.getByText(/Workspace restored/i).first()).toBeVisible({ timeout: 20_000 });

  await strangerPage.goto("/leads");
  await expect(strangerPage.getByRole("heading", { name: "Leads" })).toBeVisible({ timeout: 20_000 });

  await strangerContext.close();
  await ownerContext.close();
});

test("impersonation starts read-only, refuses writes, needs a typed confirmation, and is audited", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ensureUser(ownerPage, owner);
  await openWorkspace(ownerPage, stranger.company);
  const workspaceUrl = ownerPage.url();

  await ownerPage.getByRole("button", { name: "Impersonate" }).first().click();
  await ownerPage.waitForURL("**/dashboard", { timeout: 30_000 });

  // The banner is part of the shell: the owner can never forget where they are.
  await expect(ownerPage.getByTestId("impersonation-banner")).toBeVisible();
  await expect(ownerPage.getByText(/Read-only view/i)).toBeVisible();

  // Read-only means read-only in the UI too...
  await ownerPage.goto("/leads");
  await expect(ownerPage.getByText(/Read-only access/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByRole("button", { name: "New lead" })).toHaveCount(0);

  // Settings, billing, passwords and team roles used to slip past this: the gate only
  // covered actions that named a permission. The page says so up front now, and the
  // server refuses even if the form is posted by hand.
  await ownerPage.goto("/settings");
  await expect(ownerPage.getByText(/Read-only mode/i).first()).toBeVisible({ timeout: 20_000 });

  // ...and a wrong confirmation word must not unlock writes.
  await ownerPage.getByRole("button", { name: /Switch to write mode/i }).click();
  await ownerPage.getByLabel(/Type IMPERSONATE/i).fill("yes");
  await ownerPage.getByRole("button", { name: /Enable write mode/i }).click();
  await expect(ownerPage.getByText(/Type IMPERSONATE to confirm/i)).toBeVisible({ timeout: 20_000 });
  await expect(ownerPage.getByText(/Read-only view/i)).toBeVisible();

  // The exact word does.
  await ownerPage.getByLabel(/Type IMPERSONATE/i).fill("IMPERSONATE");
  await ownerPage.getByRole("button", { name: /Enable write mode/i }).click();
  await expect(ownerPage.getByText(/Write mode — changes are real/i)).toBeVisible({ timeout: 20_000 });

  // The notice disappears with the mode, so it is describing the session, not the page.
  await ownerPage.goto("/settings");
  await expect(ownerPage.getByText(/Read-only mode/i)).toHaveCount(0);

  // A real write now goes through, as the customer.
  await ownerPage.goto("/leads?new=1");
  await ownerPage.getByLabel("Name *").fill("Impersonated Lead");
  await ownerPage.getByLabel("Email").fill(`impersonated.${stamp}@example.com`);
  await ownerPage.getByLabel("Estimated value").fill("1200");
  await ownerPage.getByRole("button", { name: "Create lead" }).click();
  await ownerPage.waitForURL(/\/leads\/[0-9a-f-]{8,}/, { timeout: 30_000 });
  await expect(ownerPage.getByRole("heading", { name: "Impersonated Lead" })).toBeVisible();

  // Exit returns to the workspace record, and the admin panel works again.
  await ownerPage.getByRole("button", { name: "Exit" }).click();
  await ownerPage.waitForURL("**/admin/workspaces**", { timeout: 30_000 });
  await expect(ownerPage.getByTestId("impersonation-banner")).toHaveCount(0);
  expect((await ownerPage.goto(workspaceUrl))?.status()).toBe(200);

  // The write is on the record as an impersonated write, not as the customer acting.
  await expect(ownerPage.getByText("impersonated_write").first()).toBeVisible({ timeout: 20_000 });

  await ownerContext.close();
});
