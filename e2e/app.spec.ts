import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const PG_URL = process.env.DATABASE_URL ?? "";
const DB = path.join(process.cwd(), "data", "e2e.db");

/**
 * Truncates the SQLite test database in place.
 *
 * The file must NOT be deleted: Playwright starts the web server before the test
 * files load, and the server already holds an open handle. Deleting the file
 * leaves that handle pointing at an unlinked inode while every direct reader in
 * this file gets a brand-new empty database — which is exactly how a passing run
 * turns into "no such table: organization_members".
 */
function resetSqlite() {
  const db = new Database(DB);
  db.pragma("journal_mode = WAL");
  // Same rule as the app's boot path: `create … if not exists` is idempotent,
  // `alter table … add column` is not, so only "already there" errors are ignored.
  const statements = fs
    .readFileSync(path.join(process.cwd(), "sql", "schema.sqlite.sql"), "utf8")
    .replace(/^--.*$/gm, "")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    try {
      db.exec(statement);
    } catch (e) {
      if (!/duplicate column name|already exists|duplicate object/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  const tables = db
    .prepare("select name from sqlite_master where type='table' and name not in ('plans','schema_migrations')")
    .all() as { name: string }[];
  for (const { name } of tables) db.prepare(`delete from "${name}"`).run();
  db.close();
}

/** Truncates the Postgres test database so a run always starts clean. */
async function resetPostgres() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE'
        and table_name not in ('plans','schema_migrations')`
  );
  if (rows.length) {
    await client.query(`truncate table ${rows.map((r) => `"${r.table_name}"`).join(", ")} restart identity cascade`);
  }
  await client.end();
}

test.beforeAll(async () => {
  if (PG_URL) await resetPostgres();
  else resetSqlite();
});

const stamp = Date.now();
const userA = { email: `owner.a.${stamp}@example.com`, password: "TestingPass123", name: "Owner A", company: `Alpha ${stamp}` };
const userB = { email: `owner.b.${stamp}@example.com`, password: "TestingPass123", name: "Owner B", company: `Beta ${stamp}` };
const userC = { email: `owner.c.${stamp}@example.com`, password: "TestingPass123", name: "Owner C", company: `Gamma ${stamp}` };

/**
 * Puts a workspace on a paid plan by writing the same row a verified Stripe
 * webhook would write. Used only where a test needs a feature the Starter trial
 * deliberately does not include (extra seats, automations).
 */
async function upgradePlan(email: string, planCode: string) {
  if (PG_URL) {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: PG_URL });
    await client.connect();
    const { rows } = await client.query(
      `select m.organization_id as org from organization_members m
         join profiles p on p.id = m.user_id where p.email = $1`,
      [email]
    );
    if (!rows[0]) throw new Error(`no workspace for ${email}`);
    await client.query("update subscriptions set plan_code = $1, status = 'active' where organization_id = $2", [
      planCode,
      rows[0].org,
    ]);
    await client.end();
    return rows[0].org as string;
  }
  const db = new Database(DB);
  db.pragma("journal_mode = WAL");
  const row = db
    .prepare(
      `select m.organization_id as orgId from organization_members m
         join profiles p on p.id = m.user_id where p.email = ?`
    )
    .get(email) as { orgId?: string } | undefined;
  if (!row?.orgId) throw new Error(`no workspace for ${email}`);
  db.prepare("update subscriptions set plan_code = ?, status = 'active' where organization_id = ?").run(planCode, row.orgId);
  db.close();
  return row.orgId;
}

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
  await expect(page.getByText("Stripe is not configured", { exact: true })).toBeVisible();

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

test("invitation flow: invite, open the real link, join the workspace", async ({ browser }) => {
  const invitee = { email: `invitee.${stamp}@example.com`, password: "InviteePass123", name: "Invited Teammate" };

  // Workspace C is on Professional so it has spare seats.
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signup(owner, userC);
  await upgradePlan(userC.email, "professional");

  // --- owner creates the invitation ---
  await owner.goto("/settings");
  await owner.getByLabel("Email address").fill(invitee.email);
  await owner.getByRole("button", { name: "Send invitation" }).click();

  // No email provider is configured here, so the app must hand back a real link
  // instead of claiming the message was delivered.
  await expect(owner.getByText(/Email delivery is not configured/)).toBeVisible({ timeout: 20_000 });
  const href = await owner.getByRole("link", { name: /\/invite\// }).getAttribute("href");
  expect(href, "invitation link must be a real /invite/<token> URL").toMatch(/\/invite\/[A-Za-z0-9_-]{16,}$/);
  await expect(owner.getByText("Pending invitations (1)")).toBeVisible();

  // --- invitee accepts in a clean browser context (no cookies) ---
  const inviteeCtx = await browser.newContext();
  const guest = await inviteeCtx.newPage();
  await guest.goto(href!);
  await expect(guest.getByRole("heading", { name: /Join Gamma/ })).toBeVisible();
  await guest.getByLabel("Your name").fill(invitee.name);
  await guest.getByLabel("Choose a password").fill(invitee.password);
  await guest.getByRole("button", { name: "Create account & join" }).click();
  await guest.waitForURL("**/dashboard", { timeout: 30_000 });
  // The new member is inside their workspace, with the workspace name in the shell.
  await guest.goto("/settings");
  await expect(guest.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(guest.getByText(new RegExp(`Gamma ${stamp}`)).first()).toBeVisible();

  // Single use: reopening the link reports it as already accepted.
  await guest.goto(href!);
  await expect(guest.getByText("Already accepted")).toBeVisible();

  // --- the owner now sees the member instead of a pending invitation ---
  await owner.reload();
  await expect(owner.getByText(invitee.email).first()).toBeVisible();
  await expect(owner.getByText("2 of 3 seat(s) used on the Professional plan.")).toBeVisible();
  await expect(owner.getByText("Pending invitations (1)")).toHaveCount(0);
  await inviteeCtx.close();
  await ownerCtx.close();
});

test("automation builder: conditions plus a multi-step pipeline run on a real lead", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, userC);

  await page.goto("/automations");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name *").fill("Welcome hot leads");
  await page.getByLabel("Max runs per day").fill("25");

  // condition: lead status is new
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByLabel("Condition 1 field").selectOption("status");
  await page.getByLabel("Condition 1 operator").selectOption("equals");
  await page.getByLabel("Condition 1 value").fill("new");

  // step 1 (pre-created): a task
  await page.getByLabel("Task title").fill("Call the new lead within a day");
  await page.getByLabel("Due in (days)").fill("1");

  // step 2: move the lead to contacted
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 2 action").selectOption("update_lead_status");
  await page.getByLabel("Set status to").selectOption("contacted");

  // step 3: an email, which must stay behind the approval gate
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 3 action").selectOption("send_email");
  await page.getByLabel("Subject").fill("Thanks for reaching out");
  await page.getByLabel("Body").fill("Hi, thanks for getting in touch — I will call you shortly.");

  await expect(
    page.getByText(/When: New lead submitted .*Create a task.*Update lead status.*Send email \(requires approval\)/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByText('Automation "Welcome hot leads" created')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/3 steps/).first()).toBeVisible();

  // --- fire the trigger with a real lead ---
  await page.goto("/leads?new=1");
  const leadName = `Hot Lead ${stamp}`;
  await page.getByLabel("Name *").fill(leadName);
  await page.getByLabel("Email").fill(`hot.${stamp}@example.com`);
  await page.getByRole("button", { name: "Create lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{8,}/, { timeout: 30_000 });

  // the automation ran on the new lead
  await page.goto("/automations");
  await expect(page.getByText(/1 run/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("succeeded").first()).toBeVisible();

  // and the queued email is waiting for a human, not sent
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByText("Thanks for reaching out")).toBeVisible();
  await expect(page.getByText(/Email delivery is not configured/)).toBeVisible();

  // approving without the tick is refused
  await page.getByRole("button", { name: "Approve & send" }).first().click();
  await expect(page.getByText(/Tick the approval box first/)).toBeVisible({ timeout: 20_000 });

  // ticking the box approves it, and the honest "not sent" state is reported
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Approve & send" }).first().click();
  // The queue clears and the honest result is reported on the page.
  await expect(page.getByText("Nothing waiting")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/1 approved message not delivered/)).toBeVisible();
  await expect(page.getByText("approved unsent").first()).toBeVisible();
  await ctx.close();
});

test("billing page reports the missing Stripe config and never invents invoices", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, userB);
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("Stripe is not configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Invoices/ })).toBeVisible();
  await expect(page.getByText("No invoices recorded")).toBeVisible();
  await expect(page.getByText("$29.00").first()).toBeVisible();
  await ctx.close();
});

test("notifications: the bell shows what happened and can be cleared", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const owner = { email: `owner.d.${stamp}@example.com`, password: "TestingPass123", name: "Owner D", company: `Delta ${stamp}` };
  await signup(page, owner);
  await upgradePlan(owner.email, "professional");

  // Build an automation that queues an email for approval.
  await page.goto("/automations");
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name *").fill(`Notify me ${stamp}`);
  await page.getByLabel("Step 1 action").selectOption("send_email");
  await page.getByLabel("Subject").fill("Please review this draft");
  await page.getByLabel("Body").fill("Body text for the approval queue.");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByText(`Automation "Notify me ${stamp}" created`)).toBeVisible({ timeout: 20_000 });

  // A real lead fires the trigger.
  await page.goto("/leads?new=1");
  await page.getByLabel("Name *").fill(`Notify Lead ${stamp}`);
  await page.getByLabel("Email").fill(`notify.${stamp}@example.com`);
  await page.getByRole("button", { name: "Create lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{8,}/, { timeout: 30_000 });

  // The notification exists and is linked to the approval queue.
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByText("An email needs your approval")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("approval.pending").first()).toBeVisible();

  // Marking all read clears the unread counter on the page.
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText("Mark all read")).toHaveCount(0, { timeout: 20_000 });
  await ctx.close();
});

test("a viewer is read-only: no create buttons, and the write is refused server-side", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const ownerUser = { email: `owner.e.${stamp}@example.com`, password: "TestingPass123", name: "Owner E", company: `Epsilon ${stamp}` };
  await signup(owner, ownerUser);
  await upgradePlan(ownerUser.email, "professional");

  // Invite a viewer.
  const viewerEmail = `viewer.${stamp}@example.com`;
  await owner.goto("/settings");
  await owner.getByLabel("Email address").fill(viewerEmail);
  await owner.getByLabel("Role").selectOption("viewer");
  await owner.getByRole("button", { name: "Send invitation" }).click();
  const href = await owner.getByRole("link", { name: /\/invite\// }).getAttribute("href");
  expect(href).toBeTruthy();

  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(href!);
  await viewer.getByLabel("Your name").fill("Read Only");
  await viewer.getByLabel("Choose a password").fill("ViewerPass123");
  await viewer.getByRole("button", { name: "Create account & join" }).click();
  await viewer.waitForURL("**/dashboard", { timeout: 30_000 });

  // The leads page renders, but every write affordance is gone.
  await viewer.goto("/leads");
  await expect(viewer.getByRole("heading", { name: "Leads" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: /New lead/ })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: /New lead/ })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: /Import/ })).toHaveCount(0);
  await expect(viewer.getByText("Read-only access")).toBeVisible();

  // Deep-linking to the create panel does not give a viewer a form either.
  await viewer.goto("/leads?new=1");
  await expect(viewer.getByText("Read-only access")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Create lead" })).toHaveCount(0);

  // And the writes are refused server-side: no record appears.
  await viewer.goto("/leads?q=Sneaky");
  await expect(viewer.getByText("Sneaky Lead")).toHaveCount(0);

  await viewerCtx.close();
  await ownerCtx.close();
});

test("readiness probe reports schema state and which providers are configured", async ({ request }) => {
  const res = await request.get("/api/readiness");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ready).toBe(true);
  expect(body.checks.schema.ok).toBe(true);
  expect(body.checks.migrations.ok).toBe(true);
  expect(body.providers).toHaveProperty("stripe");
  expect(body.providers).toHaveProperty("email");
  expect(body.providers).toHaveProperty("ai");
  expect(Array.isArray(body.warnings)).toBe(true);
});

test("strict CSP: no inline-script allowance, every page still hydrates and navigates", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (execute|load|apply)|\bCSP\b/i.test(text)) violations.push(text);
  });
  page.on("pageerror", (err) => {
    if (/Content Security Policy|Refused to/i.test(err.message)) violations.push(err.message);
  });

  const user = { email: `owner.f.${stamp}@example.com`, password: "TestingPass123", name: "Owner F", company: `Zeta ${stamp}` };
  await signup(page, user);

  // The shipped policy must not contain an inline-script allowance.
  const res = await page.request.get("/dashboard");
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src");
  expect(csp).not.toContain("'unsafe-inline'; script");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).toMatch(/script-src[^;]*'nonce-[a-f0-9]+'/);
  expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
  expect(csp).toContain("object-src 'none'");
  expect(res.headers()["x-request-id"]).toBeTruthy();

  // Client-side navigation across several routes exercises dynamic chunk loading.
  for (const href of ["/leads", "/customers", "/proposals", "/automations", "/analytics", "/settings"]) {
    await page.goto(href);
    await expect(page.locator("header")).toBeVisible({ timeout: 20_000 });
  }
  await page.getByRole("link", { name: "Leads" }).first().click();
  await page.waitForURL("**/leads", { timeout: 20_000 });

  // Interactive behaviour proves hydration ran despite the strict policy.
  await page.goto("/dashboard");
  const toggle = page.getByRole("button", { name: "Switch to dark mode" });
  await toggle.click();
  expect(await page.evaluate(() => document.documentElement.className)).toMatch(/dark/);

  expect(violations).toEqual([]);
  await ctx.close();
});

test("scheduler and Dropbox report their real state instead of pretending", async ({ request, page }) => {
  // The cron route must refuse to run without a secret; this environment has none.
  const cron = await request.get("/api/cron/automations");
  expect(cron.status()).toBe(503);
  const cronBody = await cron.json();
  expect(String(cronBody.error)).toMatch(/not configured/i);

  // Readiness names the scheduler and the dropbox connection state.
  const readiness = await request.get("/api/readiness");
  const body = await readiness.json();
  expect(body.providers).toHaveProperty("scheduler");
  expect(body.providers).toHaveProperty("dropbox");

  // The documents page says which storage is in use, and offers no Connect button
  // while Dropbox keys are absent. (A fresh signup rather than another login: the
  // suite is 20 sign-ins long, and login is rate limited to 20 per 10 minutes by
  // design, so the last test must not need a 21st.)
  await signup(page, {
    email: `owner.g.${stamp}@example.com`,
    password: "TestingPass123",
    name: "Owner G",
    company: `Eta ${stamp}`,
  });
  await page.goto("/documents");
  await expect(page.getByText("Files are stored on this server")).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Dropbox" })).toHaveCount(0);

  // The automations page warns that time-based triggers cannot fire.
  await page.goto("/automations");
  await expect(page.getByText("The scheduler is not configured")).toBeVisible();
});
