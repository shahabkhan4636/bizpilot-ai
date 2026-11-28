# Phase 5 — wireframe (approval ke liye, code abhi nahi likha)

Ye text wireframe aap ki hidayat ke mutabiq **Phase 5 se pehle** dikhaya ja raha hai.
Har screen ke neeche wo *rules* likhe hain jo code mein enforce honge (UI hide karna
gate nahi hota). Aap "approve" kahein ya tabdeeli batayein — phir main Phase 5 likhta hun.

---

## 1. `/admin/workspaces` — saare workspaces (list)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Admin                                                                       │
│ Workspaces                                         [ Users ] [ Payments ]    │
│ Har workspace ka plan, usage, status. Suspend/unsuspend reason ke sath.       │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ 41 workspaces ] [ 3 suspended ] [ 2 payment claims pending ] [ MRR Rs … ]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Search: [ naam / slug / email        ]  Plan: [ all ▾ ]  Status: [ all ▾ ]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ WORKSPACE            PLAN        SEATS  LEADS  AI/MO  STATUS      ACTIONS     │
│ ──────────────────────────────────────────────────────────────────────────── │
│ Shahab Studio        unlimited   1/∞    412    ∞     ● owner      [Open]      │
│  shahab-studio       Platform owner · never billed                            │
│                                                                              │
│ Acme Interiors       professional 2/3   188    57    ● active     [Open]      │
│  acme                Rs 22,200/mo · renews 2026-09-09                         │
│                                                                              │
│ Glow Salon           starter     1/1    250    12    ⚠ at limit   [Open]      │
│  glow-salon          Rs 8,200/mo · past_due                                   │
│                                                                              │
│ Old Test Co          starter     0/1    3      0     ⛔ suspended [Open]      │
│  old-test            suspended 2026-08-02 · “fraud check”                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1–25 of 41                                     [ ← Previous ]  [ Next → ]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- `requireSuperAdmin()` sab se pehle — non-owner ko **404** (redirect/403 nahi, warna admin area ka pata chal jata hai).
- Server-side search + pagination (LIMIT/OFFSET), 25 per page; poora table memory mein load nahi hoga.
- Har row pe "Platform owner" badge **`isPlatformOwnerWorkspace()`** se aata hai — wahi ek rule jo Phase 4 mein limits chalata hai.
- Seats column founding/owner override dikhata hai (`1/3` = Founding Member ke 3 seats).
- List read-only hai; koi bhi tabdeeli `[Open]` ke andar hoti hai — galti se suspend hone ka risk kam.

---

## 2. `/admin/workspaces/[id]` — ek workspace

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Workspaces                                                                  │
│ Acme Interiors        [Platform owner]? [Founding Member]? [Suspended]?       │
│ acme · created 2026-07-14 · owner: ali@acme.pk                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Plan: professional ] [ Seats 2/3 ] [ Leads 188/2,000 ] [ AI 57/1,000 ]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ TAB:  ( Members )   Payments   Activity   Danger zone                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ MEMBERS                                                          (tab)       │
│ NAME              EMAIL                  ROLE     JOINED    ACTIONS          │
│ Ali Raza          ali@acme.pk            owner    14 Jul    [Impersonate]    │
│ Sana Khan         sana@acme.pk           manager  20 Jul    [Impersonate]    │
│ bilal@acme.pk     — (invite pending)     viewer   —         [Revoke invite]  │
├──────────────────────────────────────────────────────────────────────────────┤
│ PLAN & BILLING                                                               │
│ Plan [ starter ▾ ]  Cycle [ monthly ▾ ]  [ Apply plan ]  (audited)           │
│ Founding Member:  • not a member      [ Grant ]  (reason required)           │
│                   • OR locked Rs 1,500/mo, 3 seats [ Revoke ] (reason req.)   │
├──────────────────────────────────────────────────────────────────────────────┤
│ DANGER ZONE                                                                  │
│ Suspend this workspace  [ reason: ______________________ ] [ Suspend ]        │
│   ↳ suspend karte hi: writes blocked (members ko "workspace suspended"),     │
│     owner ko email + in-app notification, audit row `workspace.suspended`.    │
│ Unsuspend                [ reason: ______________________ ] [ Unsuspend ]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- Har action ke saath **reason lazmi** (min 5 chars) — audit log mein reason + actor + before/after.
- Suspend → `organizations.suspended_at` set; **server-side** koi bhi write action refuse (sirf banner nahi). Login chalta rahega taake customer billing dekh sake, magar data change nahi.
- Owner ko notification + email dono (outbox ke zariye, retry ke sath).
- `Platform owner` workspace ko suspend karne ki koshish → clear error (`refused: platform owner workspace`), taake ek galti se poora admin band na ho jaye.

---

## 3. Impersonation — "view as user" (read-only default)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Viewing as: Ali Raza (ali@acme.pk) · Acme Interiors                          │
│ MODE: (●) Read-only   ( ) Write mode     [ Exit ]                            │
│ ⚠ Read-only: aap dekh sakte hain, save nahi kar sakte.                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Write mode dabane pe confirmation:                                            │
│   ┌────────────────────────────────────────────────────────────┐             │
│   │ Write mode on karein?                                      │             │
│   │ Aap Ali Raza ki taraf se ASLI tabdeeliyan karenge. Har save │             │
│   │ `impersonated_write: true` ke sath audit hoga aur workspace  │             │
│   │ owner ko notification jayegi.                              │             │
│   │ Type karein: IMPERSONATE          [ Cancel ]  [ Confirm ]   │             │
│   └────────────────────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- Session mein `impersonated_by = <admin id>`; banner har page pe (dismiss nahi hota).
- **Read-only default:** `can()`/`requirePermission` impersonation ke dauran write permissions `false` — enforcement `authz` layer pe, UI toggle pe nahi.
- Write mode ke liye exact word `IMPERSONATE` type karna hoga (accidental click se bachne ke liye).
- Har write ke audit metadata mein `impersonated_write: true` + `impersonated_by`; workspace owner ko notification.
- Impersonation start/stop bhi audited (`impersonation.started`, `impersonation.ended`), aur **platform owner workspace** ko impersonate nahi kiya ja sakta.
- Exit pe seedha `/admin/workspaces/[id]` pe wapas.

---

## 4. `/admin/payments` — paison ki ek jagah

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Admin                                                                       │
│ Payments                                             [ Workspaces ] [ Users ] │
│ Do raaste, do alag tabs: platform (aap ko) aur workspace (customer ko).        │
├──────────────────────────────────────────────────────────────────────────────┤
│ TAB:  ( Platform → aap )   Workspace payments   Refunds                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Pending 2 · Rs 24,600 ] [ Approved 30d Rs 96,000 ] [ Rejected 30d 3 ]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ PENDING                                                                      │
│ WORKSPACE        PLAN/CYCLE      AMOUNT   METHOD   TXN ID      SUBMITTED     │
│ Acme Interiors   professional/m  Rs 22,200 SadaPay  TX-88213   12m ago       │
│   note: “paid from Easypaisa”        [ Approve ]  [ Reject + reason ]        │
│ Glow Salon       starter/m       Rs 1,500  Bank     TX-88190   2h ago        │
│   ⚑ founding price                   [ Approve ]  [ Reject + reason ]        │
├──────────────────────────────────────────────────────────────────────────────┤
│ RECENT                                                                       │
│ 2026-08-09  Acme Interiors   approved  Rs 22,200  by owner  ₹ self? no       │
│ 2026-08-09  Demo Workspace   approved  Rs 22,200  by owner  ⚑ self-approved  │
│ 2026-08-08  Glow Salon       rejected  Rs 22,200  “txn not found”            │
├──────────────────────────────────────────────────────────────────────────────┤
│ WORKSPACE PAYMENTS tab: customer ke apne clients ke claims (local_payment_    │
│ requests) — wahi jo har workspace apni /billing/local pe dekhta hai, yahan    │
│ support/monitoring ke liye read-only + escalated approve.                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- Platform claims **wahi actions** jo Phase 3 mein bane (`approvePlatformClaimAction` / `rejectPlatformClaimAction`) — koi naya approve path nahi, warna do jagah paisa activate hone lagta hai.
- `self-approved` badge har us claim pe jahan approver = claimant (Phase 3 ka `self_approved` flag).
- Amount server-side compute (form se nahi) — pehle se enforced.
- Workspace payments tab **read-only monitor** by default; escalate karke approve karne ka option alag button ke peeche + audited, taake ek admin galti se kisi customer ka paisa activate na kar de.
- Har tab ke numbers ek hi query se: `platform_payment_claims` vs `local_payment_requests` — kabhi mix nahi.

---

## Phase 5 file plan (approve hone par)

| File | Kaam |
| --- | --- |
| `src/app/admin/workspaces/page.tsx` | list + search + pagination + owner badge |
| `src/app/admin/workspaces/[id]/page.tsx` | detail: members, plan, founding, danger zone |
| `src/app/admin/payments/page.tsx` | 3 tabs (platform / workspace / refunds) |
| `src/app/admin/users/page.tsx` | users + unverified + last login |
| `src/lib/actions/admin-workspaces.ts` | suspend/unsuspend (reason + audit + notify), plan apply |
| `src/lib/impersonation.ts` + `src/lib/actions/impersonation.ts` | start/stop, read-only default, write-mode confirm |
| `src/components/admin/*` | list/detail/confirm forms |
| migration `012` | `impersonation_sessions` (admin, target user, mode, started/ended) + `organizations.suspension_reason` |
| tests | unit (RBAC, suspend blocks writes, impersonation read-only refuse, write-mode audit) + e2e (owner dekhta hai / non-admin 404, suspend → write refused, impersonate → banner + read-only save refused) |

**Total naye e2e ~5, unit ~20** (test count kabhi kam nahi hoga).
