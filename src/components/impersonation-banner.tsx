"use client";

import { useActionState, useState } from "react";
import { Eye, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label } from "@/components/ui/input";
import {
  endImpersonationAction,
  setImpersonationModeAction,
  type AdminWorkspaceState,
} from "@/lib/actions/admin-workspaces";
// A "use server" module may only export async functions, and the browser bundle must
// not pull in the database-backed impersonation module, so the word comes from the
// shared constants file.
import { IMPERSONATION_CONFIRM_WORD as IMPERSONATION_CONFIRMATION_WORD } from "@/lib/impersonation-shared";

/**
 * The impersonation banner.
 *
 * Deliberately part of the shell and not dismissible: while the platform owner is
 * inside a customer's workspace, every screen must say so. The mode switch is a
 * two-step control because "write mode" is the only part of this feature that can
 * change a customer's data.
 */
export function ImpersonationBanner({
  adminEmail,
  mode,
  expiresAt,
  returnTo,
}: {
  adminEmail: string;
  mode: "read_only" | "write";
  expiresAt: string;
  returnTo: string;
}) {
  const [state, action, pending] = useActionState(setImpersonationModeAction, null as AdminWorkspaceState);
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState("");

  const minutesLeft = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));

  return (
    <div
      data-testid="impersonation-banner"
      className={
        mode === "write"
          ? "border-b border-amber-300 bg-amber-100 px-4 py-2 text-amber-950 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-100"
          : "border-b border-sky-300 bg-sky-100 px-4 py-2 text-sky-950 dark:border-sky-800 dark:bg-sky-950/70 dark:text-sky-100"
      }
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold">
          {mode === "write" ? <ShieldAlert className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {mode === "write" ? "Write mode — changes are real" : "Read-only view"}
        </span>
        <span className="opacity-80">
          You ({adminEmail}) are viewing this workspace as its member. Session ends in {minutesLeft} min.
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mode === "read_only" ? (
            confirming ? (
              <form action={action} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="mode" value="write" />
                <div className="space-y-0.5">
                  <Label htmlFor="impersonation-confirm" className="text-[11px]">
                    Type {IMPERSONATION_CONFIRMATION_WORD} to make real changes
                  </Label>
                  <Input
                    id="impersonation-confirm"
                    name="confirmation"
                    value={word}
                    onChange={(event) => setWord(event.target.value)}
                    className="h-8 w-52 text-xs"
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" size="sm" variant="danger" disabled={pending}>
                  {pending ? "Enabling…" : "Enable write mode"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
                Switch to write mode
              </Button>
            )
          ) : (
            <form action={action}>
              <input type="hidden" name="mode" value="read_only" />
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                Back to read-only
              </Button>
            </form>
          )}

          <form action={endImpersonationAction}>
            <input type="hidden" name="return_to" value={returnTo} />
            <Button type="submit" size="sm" variant="secondary">
              <LogOut className="h-4 w-4" /> Exit
            </Button>
          </form>
        </div>
      </div>

      {state?.error ? (
        <div className="mx-auto mt-2 max-w-6xl">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}
      {state?.notice ? (
        <div className="mx-auto mt-2 max-w-6xl">
          <Alert tone="warning">{state.notice}</Alert>
        </div>
      ) : null}
    </div>
  );
}
