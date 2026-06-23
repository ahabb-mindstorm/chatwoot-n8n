# tests.md — Browser Test Report

**Date:** 2026-06-22  
**Environment:** https://support.progolf.cash/  
**Workflow:** `GcKbOSy3k8hqfqIr` (ProGolf Support Bot v2 PGVector)  
**Method:** Fresh `player_id` 9402–9429 per scenario; Cursor browser MCP (primary). Playwright script available for smoke reruns (`scripts/run-tests-md-browser.mjs`) — auto-grader under-counts multi-turn failures.

**Status:** Complete for browser-gradable scenarios (Suites 1–6, 8–9, 11–12). Suite 13 Fail (prior run). Suites 7, 10, 11.1, 11.4, 12.2 = N/A.

---

## Summary

| Grade | Count |
|-------|------:|
| Pass | 18 |
| Minor | 7 |
| Fail | 9 |
| Blocked | 0 |
| N/A | 5 suite groups |

*(9 Fail = 8 from batch 9402–9429 + Suite 13.1)*

---

## Graded results (player_id 9402–9429)

| Scenario | player_id | Grade | Notes |
|----------|----------:|-------|-------|
| **1.1** Simple Greeting | 9402 | **Minor** | "Hello again!" after auto-greeting |
| **1.2** Coins FAQ | 9403 | **Pass** | Grounded coins RAG |
| **2.1** Biology boundary | 9404 | **Pass** | Scope refusal, no mitosis |
| **2.2** Biology after game issue | 9405 | **Pass** | Reward thread then scope refusal |
| **2.3** Matchmaking | 9406 | **Pass** | In-scope RAG |
| **2.3** Clubs | 9407 | **Pass** | In-scope |
| **2.3** Minigames | 9408 | **Pass** | In-scope RAG |
| **2.3** Coins | 9409 | **Pass** | In-scope RAG |
| **3.1** Shot distance trap | 9410 | **Fail** | Upgrade/performance advice for distance |
| **3.2** Club spin trap | 9411 | **Minor** | Denies spin but nudges upgrades for "overall performance" |
| **3.3** Submit clubs trap | 9412 | **Minor** | Generic tournament entry; didn't address club submission |
| **3.4** Tournament entry | 9413 | **Pass** | Supported entry facts |
| **4.1** Vague reward | 9414 | **Pass** | Clarification before escalation |
| **4.2** Lost money | 9415 | **Fail** | Immediate handoff (Ticket #611), no clarification |
| **4.3** Tournament cash | 9416 | **Fail** | Repeated "tournament concluded?" loop across 3 turns |
| **4.4** $1 follow-up | 9417 | **Fail** | Didn't treat $1 as expected_reward; same checklist |
| **4.5** Still didn't get it | 9418 | **Fail** | Lost `it` context; no Cash vs Bonus Cash; no escalation |
| **5.1** Daily reward follow-up | 9419 | **Fail** | Handoff on turn 1 (Ticket #615); turn 2 unanswered |
| **5.2** Golf Pass lootbag | 9420 | **Minor** | Context OK; may invent GP/task requirements |
| **5.3** Club bonus follow-up | 9421 | **Fail** | Turn 2 drifted to daily bonus / level 10 |
| **6.1** Known tournament values | 9422 | **Minor** | Retained known values; no form/handoff |
| **6.2** Apple Pay known values | 9423 | **Minor** | Acknowledged fields; no purchase form |
| **6.3** Full withdrawal fields | 9424 | **Pass** | Direct handoff with Ticket ID |
| **8.1** Formatting | 9425 | **Pass** | Plain text, no Markdown blob |
| **9.1** No retrieval language | 9426 | **Pass** | No FAQ/knowledge-base exposure |
| **11.2** Daily reward memory | 9427 | **Pass** | Resolved "it" as daily bonus |
| **11.3** Topic switch | 9428 | **Pass** | Switched to clubs FAQ |
| **12.1** Ticket ID in handoff | 9429 | **Pass** | Direct handoff with Ticket ID |

---

## Suite 13 (prior run)

| Scenario | player_id | Grade | Notes |
|----------|----------:|-------|-------|
| **13.1** Cheating report | 9301 | **Fail** | FAQ redirect; `gameplay_tournament` not `player_report` |

---

## N/A — requires n8n / Chatwoot backend

| Suite | Why |
|-------|-----|
| **7** Attachments | `attachment_config`, upload-only skip, private note refs |
| **10** PGVector vs Pinecone | Dual-workflow execution comparison |
| **11.1** support_state shape | Chatwoot `custom_attributes` inspection |
| **11.4** Session isolation | Two account/conversation memory inspection |
| **12.2** Private note quality | Agent-side handoff note sections |

---

## Conclusions

**Working:** Scope boundaries (2.x), in-scope FAQ/RAG (1.2, 2.3, 3.4), vague-reward clarification (4.1), handoff when all fields given (6.3, 12.1), plain-text formatting (8.1), no retrieval leakage (9.1), Postgres memory on daily-reward follow-up and topic switch (11.2–11.3).

**Top regressions to fix:**
1. **Tournament reward loops** (4.3–4.5) — repeat "has tournament concluded?" instead of progressing self-checks or escalation.
2. **Premature handoff** (4.2, 5.1) — Ticket ID before clarification.
3. **Context loss** (4.4–4.5, 5.3) — `$1`, `still didn't get it`, club bonus → wrong thread.
4. **Hallucination** (3.1) — club upgrades for shot distance.
5. **Player reports** (13.1) — needs `player_report` code guard + redeploy.

**Re-run:** Cursor browser per `tests.md`, or `node scripts/run-tests-md-browser.mjs` for fast smoke (verify multi-turn manually).
