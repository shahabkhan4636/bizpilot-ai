# Payments for the Pakistani market — what works today, what needs a merchant account

This document exists because the honest answer here is more useful than a fake integration. Read the table
before promising a customer "online payment".

## The landscape, checked rather than assumed

| Option | Can it take money on this site today? | What it actually requires |
| --- | --- | --- |
| **Stripe** (what the code already had) | **No, for a Pakistani business.** Stripe does not onboard Pakistan-domiciled companies | a company/entity in a Stripe-supported country. This is why card checkout shows "not configured" even when you have keys for a foreign entity |
| **SadaPay / SadaBiz** | Not as a gateway in this repo | a SadaBiz merchant account (CNIC + business documents, approval, per-transaction fee). Then their merchant API/payment links can be integrated — the plug-in point is described below |
| **JazzCash merchant** | Not as a gateway in this repo | a JazzCash merchant account through a partner bank, plus a merchant ID, password and **integrity salt** from the provider |
| **EasyPaisa merchant** | Not as a gateway in this repo | an EasyPaisa merchant store ID and credentials, issued after merchant onboarding |
| **Safepay / PayFast / bSecure** (Pakistani aggregators) | Not in this repo | merchant onboarding with the aggregator; they front cards + wallets behind one API |
| **Transfer to your own wallet / bank, approved inside the app** | **YES — working now, no third party** | nothing. You already have a SadaPay/JazzCash/EasyPaisa account |

That last row is not a downgrade — it is how a very large share of Pakistani SMB software is actually paid
for, and it is the only option that can take money on **day one**.

## What is implemented (and tested)

`/billing/local` — "Local payments":

1. **Owner/admin adds a payout account** — SadaPay, JazzCash, EasyPaisa, bank IBAN or "other".
   The number format is validated server-side (wallet numbers must be `03xxxxxxxxx`; bank must be a real
   Pakistani IBAN or an 8–20 digit account), because a wrong number means a customer's money is gone.
2. **A payment link/QR can be attached** — pasted links are restricted to `http(s)`, so a
   `javascript:` URL can never end up in an anchor.
3. **The customer submits a claim** — plan, cycle, amount in rupees, transaction ID, optional note. Only one
   claim can be open at a time, so a double submit cannot look like two payments.
4. **The owner approves or rejects it.** Approval is a separate, audited decision: it writes who approved,
   when, the amount and the reference, and only then does the subscription move to that plan with a real
   period end. Two reviewers cannot extend it twice.
5. **Everyone is told** — an in-app notification plus a workspace activity entry. Nothing is silent.

Rupee pricing comes from the real USD catalogue with a **configurable rate**:

```bash
PKR_PER_USD=280     # default; set it to the rate you actually want to charge
```

Amounts are rounded **up** to the next Rs 100 so the figure is payable. Prices are shown on the page before
anyone sends money (Starter Rs 8,200 · Professional Rs 22,200 · Business Rs 41,800 · Agency Rs 83,800 at 280).

### What this deliberately does not do

It does **not** claim a transfer happened. There is no automatic verification, because no gateway verified
anything. The status is `pending` until a human says otherwise — and if you are a one-person business, that
human is you. Approve only when the money is in your account.

## When you want automatic verification (the upgrade path)

Get one merchant account, then plug it in behind the same tables. The shape of the work:

1. Add a provider module `src/lib/payments/<provider>.ts` exposing
   `createCheckout({ orgId, planCode, cycle, amountPkr, returnUrl }) → { redirectUrl, providerRef }`
   and `verifyCallback(request) → { providerRef, paidAmountPkr, status }` with a **signature check**.
2. On a verified callback, insert into `local_payment_requests` with
   `status = 'pending'` and a marker such as `reference = '<provider>:<ref>'`, then call the same approval
   path (or auto-approve only after the signature check passes).
3. Reuse the existing approval code so the subscription maths and the audit trail stay in one place.

Nothing else in the product has to change: the plan catalogue, entitlements, notifications and audit log are
already provider-agnostic.

### Provider requirements you will be asked for

- **SadaPay / SadaBiz:** business name, NTN/CNIC, bank details, website URL, approval, then merchant API
  credentials. Their pay links are the fastest path to something clickable.
- **JazzCash merchant:** merchant ID, password, integrity salt, return URL whitelisted with them.
- **EasyPaisa merchant:** store ID, credentials, return URL.
- **Safepay / PayFast:** merchant onboarding, API key + webhook secret.

Until one of those exists, card checkout stays honestly disabled and rupee payments go through the
approval flow.

## Fees and practical notes (2026, indicative — confirm with the provider)

- Wallet transfers between Pakistani wallets/banks: usually free or a flat few rupees.
- Aggregators/gateways: roughly 2–3% per transaction.
- Monthly plan in rupees is the norm for local SMBs; annual prepay with a discount (the catalogue already
  gives 10-months-for-12) closes cash-flow faster.
- Keep the **transfer note** (`BP-<workspace>`) in the customer's message: that string is how you match a
  transfer to a workspace when three payments land on the same day.
