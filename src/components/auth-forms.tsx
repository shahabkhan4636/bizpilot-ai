"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { Alert } from "./ui/alert";
import { Input, Label, Select, FieldError } from "./ui/input";
import {
  signupAction,
  loginAction,
  requestPasswordResetAction,
  resetPasswordAction,
  onboardingAction,
  type ActionState,
} from "@/lib/actions/auth";

function Feedback({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <>
      {state.error ? <Alert tone="danger" title="Could not continue">{state.error}</Alert> : null}
      {state.notice ? <Alert tone="success" title="Check your inbox">{state.notice}</Alert> : null}
      {state.fieldErrors?.resetLink ? (
        <Alert tone="warning" title="Email delivery is not configured">
          <p className="mb-2">No email provider is set up in this deployment, so the reset link is shown here instead. In production it is emailed.</p>
          <Link href={state.fieldErrors.resetLink} className="break-all font-mono text-xs underline">
            {state.fieldErrors.resetLink}
          </Link>
        </Alert>
      ) : null}
    </>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState(signupAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Feedback state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="fullName">Your name</Label>
        <Input id="fullName" name="fullName" autoComplete="name" required placeholder="Ayesha Khan" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" name="companyName" required placeholder="Northwind Studio" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} placeholder="At least 10 characters" />
        <p className="text-xs text-[hsl(var(--fg-muted))]">10+ characters with at least one letter and one number.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="country">Country</Label>
        <Select id="country" name="country" defaultValue="US">
          {["US", "PK", "GB", "CA", "AE", "AU", "DE", "IN", "SG", "Other"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating workspace…" : "Create workspace"}
      </Button>
      <p className="text-center text-xs text-[hsl(var(--fg-muted))]">
        By continuing you agree to the <Link href="/terms" className="underline">terms</Link> and{" "}
        <Link href="/privacy" className="underline">privacy policy</Link>.
      </p>
    </form>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Feedback state={state} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/forgot-password" className="text-xs text-brand-600 hover:underline">Forgot password?</Link>
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Feedback state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="email">Account email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Working…" : "Send reset link"}
      </Button>
      <p className="text-center text-xs text-[hsl(var(--fg-muted))]">
        <Link href="/login" className="underline">Back to sign in</Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="token" value={token} />
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <FieldError>{state?.fieldErrors?.password}</FieldError>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

export function OnboardingForm({ defaultName }: { defaultName: string }) {
  const [state, action, pending] = useActionState(onboardingAction, null);
  return (
    <form action={action} className="space-y-4" noValidate>
      <Feedback state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="businessType">What kind of business is {defaultName}?</Label>
        <Select id="businessType" name="businessType" defaultValue="agency">
          <option value="agency">Agency / consultancy</option>
          <option value="services">Professional services</option>
          <option value="ecommerce">E-commerce</option>
          <option value="realestate">Real estate</option>
          <option value="fitness">Health &amp; fitness</option>
          <option value="education">Education</option>
          <option value="construction">Construction / trades</option>
          <option value="other">Something else</option>
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="website">Website (optional)</Label>
          <Input id="website" name="website" placeholder="https://" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Business phone (optional)</Label>
          <Input id="phone" name="phone" placeholder="+1 555 0100" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="timezone">Timezone</Label>
          <Select id="timezone" name="timezone" defaultValue="Asia/Karachi">
            {["UTC", "Asia/Karachi", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" defaultValue="USD">
            {["USD", "PKR", "GBP", "EUR", "AED", "CAD", "AUD", "INR"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Finish setup"}
      </Button>
    </form>
  );
}
