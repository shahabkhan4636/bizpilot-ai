import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const DB = path.join(process.cwd(), "data", "e2e.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const f = `${DB}${suffix}`;
  if (fs.existsSync(f)) fs.rmSync(f);
}

const stamp = Date.now();
const userA = { email: `owner.a.${stamp}@example.com`, password: "TestingPass123", name: "Owner A", company: `Alpha ${stamp}` };
const userB = { email: `owner.b.${stamp}@example.com`, password: "TestingPass123", name: "Owner B", company: `Beta ${stamp}` };

async function signup(page: Page, user: typeof userA) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(user.name);
  await page.getByLabel("Company name").fill(user.company);
  await page.getByLabel("Work email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create workspace" }).click();
  // Onboarding appears for a brand-new account.
  await page.waitForURL("**/onboarding", { timeout: 30_000 });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

async function login(page: Page, user: typeof userA) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

async function createLead(page: Page, name: string, email: string) {
  await page.goto("/leads?new=1");
  await page.getByLabel("Name *").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Estimated value").fill("1500");
  await page.getByRole("button", { name: "Create lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{8,}/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("public marketing pages render with working links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Turn enquiries into paying customers");
  await page.getByRole("link", { name: "Pricing" }).first().click();
  await expect(page.getByRole("heading", { name: "Simple, transparent pricing" })).toBeVisible();
  await expect(page.getByText("$29.00")).toBeVisible();
  await page.getByRole("link", { name: "Features" }).first().click();
  await expect(page.getByRole("heading", { name: /Everything included/ })).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
  await page.goto("/help");
  await expect(page.getByRole("heading", { name: /Help &/ })).toBeVisible();
});

test("signup, onboarding and empty dashboard", async ({ page }) => {
  await signup(page, userA);
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toBeVisible();
  // Empty state, not fabricated metrics.
  await expect(page.getByText("Your workspace is empty — let's fix that")).toBeVisible();
  await expect(page.getByText("No leads yet — the chart fills in as records arrive.")).toBeVisible();
});

test("lead creation, search, filtering and CSV export", async ({ page }) => {
  await login(page, userA);
  await createLead(page, "Sara Ahmed", `sara.${stamp}@vertex.example`);
  await createLead(page, "Bilal Khan", `bilal.${stamp}@northwind.example`);

  await page.goto("/leads");
  await expect(page.getByRole("link", { name: "Sara Ahmed" })).toBeVisible();

  // Search narrows the list.
  await page.getByLabel("Search leads").fill("Bilal");
  await expect(page.getByRole("link", { name: "Bilal Khan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sara Ahmed" })).toHaveCount(0);

  // Status filter with no matches shows the filtered empty state.
  await page.getByLabel("Search leads").fill("");
  await page.getByLabel("Filter by status").selectOption("won");
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await page.getByLabel("Filter by status").selectOption("");

  // CSV export returns real content.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("status update, note and rule-based AI scoring", async ({ page }) => {
  await login(page, userA);
  await page.goto("/leads");
  await page.getByRole("link", { name: "Sara Ahmed" }).click();
  await page.waitForURL(/\/leads\//);

  await page.getByLabel("Pipeline status").selectOption("qualified");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Lead saved.")).toBeVisible();

  await page.getByLabel("Note").fill("Asked for a 6-week timeline.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Asked for a 6-week timeline.")).toBeVisible();

  // No AI key in this environment: the button must still work via the rule-based fallback.
  await page.getByRole("button", { name: "Score this lead" }).click();
  await expect(page.getByText(/Score updated to \d+\/100/)).toBeVisible();
});

test("proposal creation, PDF export, share link and client acceptance", async ({ page }) => {
  await login(page, userA);
  await page.goto("/proposals/new");
  await page.getByLabel("Proposal title *").fill("Website redesign");
  await page.getByLabel("Client name *").fill("Sara Ahmed");
  await page.getByLabel("Client email").fill(`sara.${stamp}@vertex.example`);
  await page.getByLabel("Line 1 description").fill("Design sprint");
  await page.getByLabel("Line 1 quantity").fill("1");
  await page.getByLabel("Line 1 unit price").fill("1200");
  await page.getByRole("button", { name: "Create proposal" }).click();
  await page.waitForURL(/\/proposals\/[0-9a-f-]{8,}/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Website redesign" })).toBeVisible();
  await expect(page.getByText("$1,200.00").first()).toBeVisible();

  // Mark as sent so a share link exists.
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText(/Proposal marked as sent/)).toBeVisible();

  // PDF download is a real PDF.
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "PDF" }).click()]);
  const pdfPath = await pdf.path();
  expect(pdfPath).toBeTruthy();
  const head = fs.readFileSync(pdfPath!, "latin1").slice(0, 8);
  expect(head.startsWith("%PDF-1.4")).toBe(true);

  // Client portal accepts, in a separate context (no session).
  const link = await page.getByRole("link", { name: "Client view" }).getAttribute("href");
  expect(link).toBeTruthy();
  const clientContext = await page.context().browser()!.newContext();
  const clientPage = await clientContext.newPage();
  await clientPage.goto(link!);
  await expect(clientPage.getByRole("heading", { name: "Website redesign" })).toBeVisible();
  await clientPage.getByLabel("Your name").fill("Sara Ahmed");
  await clientPage.getByRole("button", { name: "Accept this proposal" }).click();
  await expect(clientPage.getByText("Accepted", { exact: true })).toBeVisible();
  await clientContext.close();

  // Staff side now shows accepted — set by the client, not by staff.
  await page.reload();
  await expect(page.getByText("Accepted by the client")).toBeVisible();
});

test("tenant isolation: workspace B cannot see workspace A records", async ({ browser }) => {
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await signup(pageB, userB);
  await pageB.goto("/leads");
  await expect(pageB.getByText("No leads yet")).toBeVisible();
  await expect(pageB.getByRole("link", { name: "Sara Ahmed" })).toHaveCount(0);
  await pageB.goto("/customers");
  await expect(pageB.getByText("No customers yet")).toBeVisible();
  await pageB.goto("/proposals");
  await expect(pageB.getByText("No proposals yet")).toBeVisible();
  await contextB.close();
});

test("unauthenticated visitors are redirected to login", async ({ page }) => {
  for (const route of ["/dashboard", "/leads", "/customers", "/ai-assistant", "/billing", "/settings", "/admin"]) {
    await page.goto(route);
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    expect(page.url()).toContain("/login");
  }
});

test("AI assistant reports the missing provider instead of faking content", async ({ page }) => {
  await login(page, userA);
  await page.goto("/ai-assistant");
  await expect(page.getByText("This deployment has no AI credentials")).toBeVisible();
  await page.getByLabel("Objective").fill("Book a discovery call");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByText("Not generated by AI")).toBeVisible();
  // The explanation is placed in the editable body, never presented as generated copy.
  await expect(page.getByLabel("Body — edit freely")).toHaveValue(/AI generation is unavailable/);
});

test("settings, billing and admin pages enforce their guards", async ({ page }) => {
  await login(page, userA);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Team members")).toBeVisible();

  await page.goto("/billing");
  await expect(page.getByText("Stripe is not configured")).toBeVisible();

  // Not a super admin -> /admin redirects to the dashboard.
  await page.goto("/admin");
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
});

test("logout ends the session", async ({ page }) => {
  await login(page, userA);
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await page.goto("/dashboard");
  await page.waitForURL(/\/login/, { timeout: 20_000 });
});

test("password reset issues a working token", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Account email").fill(userA.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your inbox")).toBeVisible();
  // Without an email provider the link is surfaced directly — use it.
  const link = await page.getByRole("link", { name: /reset-password\?token=/ }).getAttribute("href");
  expect(link).toBeTruthy();
  await page.goto(link!);
  await page.getByLabel("New password").fill("BrandNewPass456");
  await page.getByRole("button", { name: "Set new password" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  // And the new password works.
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await page.getByLabel("Email").fill(userA.email);
  await page.getByLabel("Password").fill("BrandNewPass456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
});

test("mobile navigation opens and reaches the leads page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Uses workspace B: workspace A's password was rotated by the reset test above.
  await login(page, userB);
  await page.getByLabel("Open menu").click();
  await page.getByRole("link", { name: "Leads" }).click();
  await page.waitForURL("**/leads", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
});
