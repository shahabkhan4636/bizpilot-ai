import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSuperAdmin, isSuperAdminEmail, superAdminEmail, superAdminFlag } from "@/lib/owner";

/**
 * Phase 1 — the platform owner is decided by `ADMIN_EMAIL`, everywhere.
 *
 * These tests pin the security-relevant behaviour of the rule itself, because a
 * mistake here is the difference between "no admin panel" and "everyone is an
 * admin":
 *
 *  - nothing is hardcoded, so no email may survive with the variable unset;
 *  - matching is case/whitespace insensitive (people type their address both ways);
 *  - a database flag on a different address cannot promote anybody.
 */

const ORIGINAL = process.env.ADMIN_EMAIL;

beforeEach(() => {
  delete process.env.ADMIN_EMAIL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ORIGINAL;
});

describe("platform owner rule", () => {
  it("has no owner when ADMIN_EMAIL is unset", () => {
    expect(superAdminEmail()).toBeNull();
    // Even a database flag cannot invent an owner: an unconfigured deployment has
    // no admin panel at all, which is the safe failure mode.
    expect(isSuperAdmin({ email: "someone@example.com", is_super_admin: 1 })).toBe(false);
    expect(isSuperAdminEmail("someone@example.com")).toBe(false);
    expect(superAdminFlag("someone@example.com")).toBe(0);
  });

  it("recognises only the configured address, ignoring case and padding", () => {
    process.env.ADMIN_EMAIL = "  Owner@Example.COM  ";
    expect(superAdminEmail()).toBe("owner@example.com");
    expect(isSuperAdmin({ email: "owner@example.com" })).toBe(true);
    expect(isSuperAdmin({ email: "OWNER@example.com" })).toBe(true);
    expect(isSuperAdmin({ email: "owner@example.com " })).toBe(true);
    expect(isSuperAdmin({ email: "owner2@example.com" })).toBe(false);
    expect(isSuperAdmin({ email: "admin@example.com" })).toBe(false);
  });

  it("cannot be promoted by a stale database flag on another address", () => {
    process.env.ADMIN_EMAIL = "owner@example.com";
    // This is the revocation case: the flag is still 1 from an old configuration.
    expect(isSuperAdmin({ email: "previous.owner@example.com", is_super_admin: 1 })).toBe(false);
    // And the flag is not required for the configured owner either (a profile created
    // before ADMIN_EMAIL was set must still work).
    expect(isSuperAdmin({ email: "owner@example.com", is_super_admin: 0 })).toBe(true);
  });

  it("treats a missing or empty user as not-an-admin", () => {
    process.env.ADMIN_EMAIL = "owner@example.com";
    expect(isSuperAdmin(null)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin({ email: "" })).toBe(false);
    expect(isSuperAdminEmail(null)).toBe(false);
  });

  it("treats a blank ADMIN_EMAIL value as unset", () => {
    process.env.ADMIN_EMAIL = "   ";
    expect(superAdminEmail()).toBeNull();
    expect(isSuperAdmin({ email: "owner@example.com", is_super_admin: 1 })).toBe(false);
  });

  it("derives the session flag from the same rule", () => {
    process.env.ADMIN_EMAIL = "owner@example.com";
    expect(superAdminFlag("owner@example.com")).toBe(1);
    expect(superAdminFlag("other@example.com")).toBe(0);
  });
});
