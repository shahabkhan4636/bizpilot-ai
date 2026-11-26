import { describe, it, expect, beforeEach } from "vitest";
import { run, get, resetDatabaseForTests } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { issueVerificationToken, consumeVerificationToken, isEmailVerified } from "@/lib/email-verification";

function addUser(email = `verify-${Date.now()}@example.com`) {
  const id = newId();
  const now = nowIso();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    id, email, null, "Verify Me", now, now,
  ]);
  return { id, email };
}

describe("email verification", () => {
  beforeEach(() => resetDatabaseForTests());

  it("starts unverified", () => {
    const { id } = addUser();
    expect(isEmailVerified(id)).toBe(false);
  });

  it("verifies with a valid token and marks the profile", () => {
    const { id, email } = addUser();
    const { token } = issueVerificationToken(id, email);
    const result = consumeVerificationToken(token);
    expect(result).toEqual({ ok: true, email });
    expect(isEmailVerified(id)).toBe(true);
  });

  it("is single use", () => {
    const { id, email } = addUser();
    const { token } = issueVerificationToken(id, email);
    expect(consumeVerificationToken(token).ok).toBe(true);
    expect(consumeVerificationToken(token)).toEqual({ ok: false, reason: "used" });
  });

  it("rejects an unknown token", () => {
    expect(consumeVerificationToken("not-a-real-token")).toEqual({ ok: false, reason: "invalid" });
    expect(consumeVerificationToken("")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an expired token", () => {
    const { id, email } = addUser();
    const { token } = issueVerificationToken(id, email);
    run("update email_verifications set expires_at = ? where user_id = ?", ["2000-01-01T00:00:00.000Z", id]);
    expect(consumeVerificationToken(token)).toEqual({ ok: false, reason: "expired" });
    expect(isEmailVerified(id)).toBe(false);
  });

  it("invalidates the previous link when a new one is issued", () => {
    const { id, email } = addUser();
    const first = issueVerificationToken(id, email).token;
    const second = issueVerificationToken(id, email).token;
    expect(consumeVerificationToken(first).ok).toBe(false);
    expect(consumeVerificationToken(second).ok).toBe(true);
  });

  it("stores only a hash of the token", () => {
    const { id, email } = addUser();
    const { token } = issueVerificationToken(id, email);
    const row = get<{ token_hash: string }>("select token_hash from email_verifications where user_id = ?", [id]);
    expect(row?.token_hash).toBeTruthy();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toHaveLength(64);
  });
});
