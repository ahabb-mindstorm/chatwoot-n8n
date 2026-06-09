# Live test report — pass 2 (v3 RAG guided bot)

**Date:** 2026-06-04  
**Plan:** `testing.md`  
**Context applied:** `testing-context.md`  
**Target:** [ProGolf withdrawal article](https://csr.progolf.cash/hc/withdrawl/articles/1778579420-progolf) + Chatwoot widget  
**Workflow:** `pi1FV25pGTEu4rwm` (`chatwoot-guided-with-rag`)

---

## Run window

| Metric | Value |
|--------|--------|
| Baseline execution (pre-test) | **1112** |
| Starting run | **1113** |
| Ending run | **1182** |
| Total n8n executions | **70** |
| Test window (UTC) | ~06:30 – 06:42 |
| Conversation | Single long session (conv **44**, contact `small-sky-526`) — no iframe nukes after initial recovery |

**Note:** 70 executions ≠ 70 user intents. Many runs are `Respond OK (skip)` from debounce/duplicate webhooks (e.g. **1125**, **1128**, **1130**, **1135**, **1170**).

---

## Automation improvements (vs pass 1)

| Applied from context | Result |
|---------------------|--------|
| `$chatwoot.toggle('open')` before sends | Fixed preview-bubble / missing textarea |
| Avoid iframe `src` reset | No “Retry later” after recovery |
| Focus `textarea[placeholder="Type your message"]` | Reduced form-field hijack |
| 26–28s wait on RAG turns | B1/B3 reliable |
| ≥4s gap between free-text | Still hit debounce on back-to-back FAQ (B2, B6) |
| Single session + `menu` for reset | Worked when not inside form |

**Still hard:** `menu` while **form** is active often does not reset (no user bubble in transcript → likely debounce or router ignores). Option clicks fail when menu not visible (F1/F2 after form stack).

---

## Summary

| | Count |
|---|------|
| Scenarios exercised | 28 |
| **Pass** (widget + expected behavior) | **14** |
| **Fail** | **8** |
| **Inconclusive / skip / automation** | **6** |
| Suites not run | C2 attachments, H edge, I exploratory, most of G, B4/B5, C2–C4 completion |

**Overall:** Core guided menu, FAQ (coins/timing/withdraw), RAG→form routing, ad sub-option skip, guardrails (refund, human), and menu breakout work. Regressions remain on out-of-scope handling, `menu` from form, and inconsistent FAQ routing (`rag_answerable`).

---

## Results by scenario

### Suite A — Entry & menu

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| A1 | `hi` | ✅ | Main `input_select` with 8 options |
| A2 | Click Missing Reward | ✅ | `missing_reward_form` shown |
| A3 | `menu` from form | ❌ | Form stayed; no `menu` bubble in transcript — reset did not apply |
| A4 | `hello` in form | ⚠️ | Re-rendered form (matches plan: active-flow greeting on non-options node) — **expected**, not a bug |
| A5 | Click Talk to a human | ✅ | Generic handoff copy shown |

### Suite B — FAQ / RAG

| ID | Action | Pass | n8n | Notes |
|----|--------|------|-----|-------|
| B1 | `what are coins for?` | ✅ | **1132** `action: reply`, `rag_answerable: true`, `Respond OK (handled)` | Clean FAQ path |
| B2 | `how to withdraw?` | ⚠️ | Skipped/debounced first try | No new reply; retry worked |
| B2-retry | `how to withdraw?` | ✅ | Handoff path with withdrawal steps in `publicAnswer` | Answer correct; route still handoff (see bugs) |
| B3 | `how long does withdrawal take?` | ✅ | RAG FAQ | 2–14 business days copy |
| B6 | `capital of France` | ❌ | Debounced first try | No response |
| B6-retry | `capital of France` | ❌ | Wrong answer | Bot replied with **withdrawal steps**, not handoff |

### Suite C — RAG → guided

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| C1 | `I lost my tournament reward yesterday` | ✅ | Routed to `missing_reward_form` |

C2–C4 (form submit → attachment → completion RAG): **not run**.

### Suite D — Guided paths

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| D8 | `inappropriate ad` | ✅ | Skipped ad submenu → `ad_details_form` directly |

Other D steps: **not run** as dedicated suite (partial overlap with A/C).

### Suite E — Break out

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| E1 | `how to withdraw?` at menu | ✅ | FAQ text (generic app-settings wording) |
| E2 | FAQ inside form | ❌ | Could not re-enter form; debounced / no new reply |
| E6 | `talk to a human` mid-flow | ✅ | Guardrail handoff |

E3–E5, E7–E10: **not run**.

### Suite F — Gameplay LLM

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| F1 | Gameplay Question | ❌ | Menu not visible (stuck in ad form stack) |
| F2 | Feature/how-to option | ❌ | Same |

### Suite G — Guardrails

| ID | Action | Pass | Notes |
|----|--------|------|-------|
| G1 | `I want a refund for my purchase` | ✅ | Handoff + billing-style escalation |

G2–G5: **not run**.

### Menu reset helpers

| ID | Pass | Notes |
|----|------|-------|
| reset-menu | ✅ | `menu` → main menu after FAQ block |
| reset1–4 from form | ❌ | `menu` did not escape nested forms (missing reward → ad form stack) |

---

## n8n execution highlights

| Run | Trigger | Last node | Outcome |
|-----|---------|-----------|---------|
| **1132** | `what are coins for?` | `Respond OK (handled)` | `action: reply`, `route: faq`, `rag_answerable: true` ✅ |
| **1125**, **1128**, **1130**, **1135**, **1170** | Various | `Respond OK (skip)` | Debounce / duplicate |
| **1165** area | `how to withdraw?` (E1) | RAG → reply path | FAQ answer in widget |
| Pass 1 **1082** | `how to withdraw?` | `Respond OK (handoff)` | `rag_answerable: false` → handoff despite good answer (still open) |

---

## Bugs & UX issues

### 1. Out-of-scope question answered as withdrawal FAQ (new)

**Input:** `what is the capital of France?`  
**Expected:** Handoff or refusal; no Paris, no ProGolf hallucination.  
**Actual:** Full withdrawal instructions (same as B2-retry tail).  
**Severity:** High — safety/scope failure.

### 2. FAQ handoff when `rag_answerable: false` (pass 1, may still affect B2-retry)

RAG returns correct FAQ + `knowledge_used` but evaluator handoffs when `rag_answerable: false` (`low_confidence_or_bad_faq`). B2-retry showed correct withdrawal text but likely still opened conversation / labels.

**Fix:** Align agent output or relax `hasRetrievalProof` in `Evaluate RAG Answer`.

### 3. `menu` ineffective inside active form

Sending `menu` via chat textarea while `missing_reward_form` (or deeper) active often produces **no menu reset**. User must complete form or start new conversation.

**Suggestion:** Document for CS; consider router treating `menu`/`help`/`start` before form branch.

### 4. Generic handoff copy for explicit “Talk to a human”

Menu handoff uses outside-scope message. Functionally OK; UX confusing.

### 5. Inbox banner “We will be back as soon as possible”

Visible during test but bot still replied. Automation should not treat as hard offline unless textarea missing.

### 6. Conversation pollution

One long conv accumulated: handoffs → forms → ads → refunds. Realistic but makes F1/F2 and menu resets harder. **Next pass:** fresh conv per suite via End Conversation (not iframe reset).

---

## Debounce observations

| Pattern | Result |
|---------|--------|
| B1 → B2 &lt;4s | B2 skipped (`changed: false`) |
| B3 → B6 &lt;4s | B6 skipped |
| `menu` after handoff | Sometimes skipped (`post-handoff-menu`) |

**Recommendation:** ≥5s between free-text messages; confirm in n8n execution list before next send.

---

## Coverage vs plan

| Suite | Planned | Pass 2 |
|-------|---------|--------|
| A | ~5 | 4/5 meaningful |
| B | ~6 | 4/6 |
| C | ~4 | 1/4 |
| C2 | ~7 | 0 |
| D | ~12 | 1 (D8) |
| E | ~10 | 2/10 |
| F | ~3 | 0/3 |
| G | ~5 | 1/5 |
| H | ~7 | 0 |
| I | 20+ | 0 |

---

## Recommendations

1. **Fix before next run:** out-of-scope routing (B6), `rag_answerable` / evaluator handoff logic.
2. **Router:** honor `menu`/`help`/`start` from form nodes.
3. **Testing:** fresh conversation per suite; Playwright helper from `testing-context.md` §Recommendations.
4. **Assert n8n:** widget pass + `get_execution` on `Evaluate RAG Answer` for every FAQ case.
5. **Re-run priority:** B6, C2 attachments, G2–G5, E2/E7, I exploratory sample.

---

## Related

- `testing.md` — full matrix  
- `testing-context.md` — tooling & environment  
- Pass 1 runs: **1049–1106** (see prior session)
