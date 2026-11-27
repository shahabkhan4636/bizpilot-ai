# First 10 paying customers — 14-day plan

Target that decides everything: **10 paying workspaces**. At the seeded prices that is $290–$1,490/month
depending on mix; a realistic first mix (6 Starter, 3 Professional, 1 Business) is **$560/month recurring**.

Nobody can promise you that, and a plan that pretends otherwise is worthless. What follows is the
cheapest sequence that gives you a real shot, with numbers you can check every day.

---

## The arithmetic (do this before day 1)

To get 10 paying customers, with honest small-business conversion rates:

| Stage | Rate | Volume needed |
| --- | --- | --- |
| People you contact | — | **150** |
| Replies | ~15% | ~22 |
| Demos (10 min) | ~50% of replies | ~11 |
| Trials started | ~70% of demos | ~8 |
| Trial → paid | ~40–70% of trials | **~4–5** |

Read that table honestly: **150 targeted contacts ≈ 4–5 customers**, not 10. So either contact ~300 people,
or get referrals to improve the rates. Anyone who tells you otherwise is selling a course.

Time: 150 personalised contacts is ~10 contacts/day × 15 days ≈ 60–90 minutes a day. It is a numbers game
with a personal first line, not a spray.

---

## Day-by-day

**Days 1–2 — set the ground**
- Deploy live (see `docs/LAUNCH-RUNBOOK.md`), Stripe in test mode, prices live on the page.
- Pick **one** niche for the fortnight. Write down 40 named businesses that fit, with a contact name.
- Build a 60-second screen recording of the enquiry → proposal → accepted flow.
- Set up a simple tracker (`lead-tracker.csv` is in this folder) — every contact gets a row and a date.

**Days 3–9 — outreach (10 contacts/day, every day)**
- Channels, in this order of yield: (1) people you already know, (2) LinkedIn/Instagram DMs to the niche,
  (3) local business groups, (4) email with one personalised line.
- Offer is always the same: *"Give me 10 minutes and I'll load your 5 real enquiries, free."*
- Book demos in a 2-hour window each day. Run the script in `marketing/LAUNCH-KIT.md` §4.
- Every demo ends with a trial started **during the call**, using their real data.

**Days 10–14 — convert and learn**
- Call every trial the day after their first "overdue follow-up" appears — that is the moment they feel it.
- Ask one question at the end of every call: *"What would have to be true for you to pay for this today?"*
  Fix whatever the first three people say in the same week — that is your product roadmap.
- On day 14, ask each trial to pay. Directly. A trial that has not converted is not a customer.

**Daily targets (write these on the wall)**

| Metric | Target |
| --- | --- |
| New contacts | 10 |
| Replies | 1–2 |
| Demos booked | 1 |
| Trials started | 0–1 |
| Paid | by day 14: 3–5 |

---

## Where the first 20 conversations actually come from

1. **Warm circle first.** Ex-colleagues, family businesses, your own past clients. Free, highest hit rate.
2. **The niche's own hashtags/locations** on Instagram: find businesses whose DMs are their intake.
3. **LinkedIn**: search "founder" + your niche + your city; message with the specific line.
4. **Local Facebook business groups** — answer a question first, then DM. Never post the link cold.
5. **Referrals**: after each new customer, "who else in your line of work loses leads like this?" — one name, not five.

---

## What to say when they ask "how is this different from HubSpot/Notion/Excel?"

> "It is not a CRM for a 200-person sales team. It is one screen: who to call today, and a proposal your
> client can accept with one click. Setup is 10 minutes because I do it with you, and you pay $29 not
> $800. If you outgrow it, export your CSV and leave — no lock-in."

---

## The only three reasons a trial does not convert (they are all fixable)

| What they say | What it really means | What you do |
| --- | --- | --- |
| "I didn't have time to set it up." | you left the setup to them | do it for them on the call, in front of them |
| "It's not really how we work." | one workflow is missing | ask exactly what happens after an enquiry; change it this week |
| "I'll pay later / after this busy season." | no felt pain yet | make them look at their own overdue list; pain, not features, converts |

---

## Tracker columns (`lead-tracker.csv`)

`business,niche,contact_name,channel,first_contact_date,replied,demo_date,trial_started,plan,trial_end,paid_date,monthly_usd,notes`

Fill one row per contact, every day, before you go to bed. If the sheet is empty at the end of a day, the
board is empty too — no product, including this one, gets customers by itself.
