# Live Chatwoot + n8n test plan (v3 RAG guided bot)

**Status:** Plan only — do not execute until approved.

**Target UI:** [ProGolf withdrawal help article](https://csr.progolf.cash/hc/withdrawl/articles/1778579420-progolf) — Chatwoot widget, bottom-right.

**Workflow under test:** `workflows/chatwoot-bot-with-rag-v3.json`  
**Live workflow id:** `pi1FV25pGTEu4rwm`  
**Webhook path:** `chatwoot-guided-with-rag`  
**Workflow name in n8n:** `Chatwoot Guided Flow + RAG Bot (Agent Bot webhook)`

---

## What this bot does (test lens)

Hybrid router + guided tree:

| Path | Trigger | Expected bot behavior |
|------|---------|----------------------|
| **Guided menu** | Fresh `hi`/`hello`/empty first message, or explicit `menu`/`help`/`start` | `input_select` main menu (`Hi, how can we help you?`) |
| **Guided navigation** | Click option or type matching option text/id | Deterministic form / submenu / text — no LLM |
| **Free text inside options node** | Type unrelated text while menu visible | Routes to **RAG Guided Agent** (`unmatched_options_text`) |
| **Free text mid-flow** | Type FAQ/issue text while in form or deep node | Routes to RAG agent (`unmatched_guided_text` or `routeToLlm`) |
| **FAQ** | Knowledge questions (`what are coins for?`, `how to withdraw?`) | Pinecone-backed public answer (`action: reply`) |
| **Personal issue** | `I lost my reward`, `my purchase failed` | RAG routes into guided form (`guided_flow`) |
| **Clarification** | Ambiguous message (FAQ + issue overlap) | Clarification menu: Show answer / Help with issue / Human |
| **Guardrails** | `talk to a human`, refund/legal/credentials phrases | Immediate handoff (labels + private note + open conversation) |
| **Guided completion RAG** | Finish form → `Nothing to attach` or upload a file on attachment prompt | RAG checks FAQ for collected details; Yes/No resolution menu or normal handoff |
| **Break out** | FAQ question while inside guided form/menu | Should hit RAG, not silently ignore user |
| **Menu reset** | `menu` / `help` / `start` anytime | Reset to main menu, clear path |
| **Active-flow greetings** | `hi` / `hello` / `hey` / `yo` inside an active flow | Re-render current prompt, not main menu |

State lives in Chatwoot `custom_attributes.n8n_guided_flow`.

---

## Run tracking (n8n MCP)

**Definition:** One customer message (or one interactive submission) → one webhook → one n8n execution = **one run**.

**Before testing:**

1. `search_workflows` with query `Chatwoot Guided Flow + RAG` → capture `workflowId`.
2. `search_executions` filtered by that `workflowId`, `limit: 1` → note latest execution `id` as **baseline** (runs after this count).

**During testing:**

- Wait ≥3s between free-text messages (default `CONVERSATION_DEBOUNCE_MS=2000`).
- Interactive button/form clicks bypass debounce — safe to click quickly.
- After each message, wait for bot reply before next send.
- If uploading a file, wait for the upload bubble to appear and then wait for the bot reply before sending anything else.

**After testing:**

- `search_executions` again → list all executions with `startedAfter` = test start timestamp.
- Report **starting run number** and **ending run number** (sequential count from baseline +1 through final).
- For failures: `get_execution` with `includeData: true`, nodes `Guided Flow Router`, `Evaluate RAG Answer`, `Respond OK (*)`.

**Note:** Skipped webhooks (duplicate, debounce, non-customer) still create executions that end early with `Respond OK (skip|dup)` — count them but flag in results.

---

## Test setup

1. Open target URL in browser.
2. Open Chatwoot widget; start **fresh conversation** (or resolve prior one to reset state).
3. Record baseline execution id + timestamp.
4. Use **one conversation per major suite** where state pollution would skew results (guided deep-dive vs FAQ vs guardrails).

### Scripted webhook testing

For repeatable test runs, prefer the webhook scenario runner over browser automation when UI behavior itself is not under test.

The runner sends Chatwoot-shaped webhook payloads directly to n8n and prints:

- a `runId` marker included in payload `additional_attributes`
- the test `startedAt` timestamp
- each synthetic message id
- an MCP hint for `search_executions`

Because the workflow fetches and updates Chatwoot conversation state, run it against a real test conversation/contact:

```bash
npm run test:webhook-scenario -- \
  --webhook-url "$N8N_WEBHOOK_URL" \
  --account-id 2 \
  --conversation-id 39 \
  --inbox-id 1 \
  --contact-id 35 \
  --scenario faq-smoke
```

Direct webhook tests may create bot replies and state updates in Chatwoot without creating matching visible customer bubbles in the widget. Treat n8n MCP execution data as the source of truth for these scripted runs.

Useful built-in scenarios:

| Scenario | Covers |
|----------|--------|
| `faq-smoke` | reset, menu, grounded FAQ, off-scope handoff |
| `missing-reward-no-attach` | guided form, attachment prompt, final no-attachment completion |
| `ad-attachment` | LLM route to ad sub-option, form submit, upload-only completion |
| `guided-breakout` | FAQ while inside guided flow, then route back into guided flow |
| `guardrails` | human/data deletion handoff paths |

List scenarios:

```bash
npm run test:webhook-scenario -- --list-scenarios
```

Custom scenarios can be stored as JSON:

```json
{
  "name": "custom-withdrawal",
  "steps": [
    { "type": "reset" },
    { "type": "text", "text": "menu" },
    { "type": "text", "text": "how to withdraw?" }
  ]
}
```

Run one:

```bash
npm run test:webhook-scenario -- \
  --env-file .env.scenario \
  --scenario-file ./tmp/custom-withdrawal.json
```

Supported step types: `reset`, `text`, `select`, `form`, `attachment`, and `sleep`.

Use browser tests only for widget-specific concerns: rendering, clicking actual Chatwoot buttons/forms, upload UI behavior, scroll/visibility, and mobile layout.

---

## Suite A — Entry & menu (Runs A1–A5)

| # | Send | Expected |
|---|------|----------|
| A1 | `hi` | Main menu `input_select` (8 options incl. Talk to a human) |
| A2 | Click **Missing Reward** | `missing_reward_form` |
| A3 | `menu` | Back to main menu; path cleared |
| A4 | `hello` | Main menu remains/re-renders because current node is already `main` |
| A5 | Click **Talk to a human** | Handoff: public ack, private note, labels, conversation opened |

**Pass criteria:** Each step gets bot response within ~30s; n8n execution success; no stuck state.

**Note:** A4 is expected to show the main menu because the conversation is already at the main menu, not because greetings should reset every active guided flow.

---

## Suite B — FAQ / RAG free-text (Runs B1–B6)

Fresh conversation. English FAQ-style questions targeting Pinecone (`pro-golf-support` index):

| # | Send | Expected route |
|---|------|----------------|
| B1 | `what are coins for?` | FAQ public answer from knowledge base |
| B2 | `how to withdraw?` | FAQ answer (withdrawal steps) |
| B3 | `how long does withdrawal take?` | FAQ answer (timing) |
| B4 | `what is Pro Pass?` | FAQ or clarification (depends on index coverage) |
| B5 | `thanks that helped` | Resolve path or brief ack (`route: resolve`) |
| B6 | `what is the capital of France?` | Handoff or out-of-scope escalation (not ProGolf) |

**Pass criteria:** B1–B3 return on-topic answers without forcing guided forms. B6 must not hallucinate travel trivia.

---

## Suite C — RAG → guided flow routing (Runs C1–C4)

Fresh conversation.

| # | Send | Expected |
|---|------|----------|
| C1 | `I lost my tournament reward yesterday` | RAG routes to `missing_reward_form` (or clarification first) |
| C2 | *(if form shown)* fill required fields + submit | `attachment_prompt` |
| C3 | Click **Nothing to attach** | RAG completion check → FAQ answer + "Did this resolve?" OR normal report-shared handoff |
| C4 | If resolution menu: click **No** | Continues normal completion → handoff message |

**Pass criteria:** Form data preserved in private handoff note if escalated.

---

## Suite C2 — Attachment completion (Runs C2.1–C2.7)

Fresh conversation for each sub-case unless noted.

| # | Setup / action | Expected |
|---|----------------|----------|
| C2.1 | Start ad issue via free text: `I got an inappropriate ad` | Routes directly to `ad_details_form`, not ad submenu |
| C2.2 | Submit ad form, then upload image/file at attachment prompt | No main menu; routes to completion RAG check with synthetic `attachment_uploaded` |
| C2.3 | If RAG is low confidence | Normal `report_shared` handoff message |
| C2.4 | Repeat but click **Nothing to attach** | Same completion behavior as before |
| C2.5 | Purchase completed path → purchase form → upload receipt at purchase attachment prompt | No main menu; completion RAG check then handoff/resolution |
| C2.6 | Type `hey` at attachment prompt | Re-renders attachment prompt, not main menu |
| C2.7 | Type `menu` at attachment prompt | Explicit reset to main menu |

**Pass criteria:** Attachment metadata may appear in state/private summaries, but no full attachment `data_url` should be stored in `custom_attributes.n8n_guided_flow`.

---

## Suite D — Full guided paths (Runs D1–D12)

Use clicks where possible. One conversation, sequential.

### D — Missing Reward (short path)

| # | Action |
|---|--------|
| D1 | `hi` → menu |
| D2 | **Missing Reward** |
| D3 | Submit form (fake but complete data) |
| D4 | **Nothing to attach** |

### D — Game issue + gameplay menu

| # | Action |
|---|--------|
| D5 | `menu` |
| D6 | **Report a Game Issue** → submit description |
| D7 | **Nothing to attach** |

### D — Ads sub-option via text (RAG skip submenu)

Fresh conversation:

| # | Send |
|---|------|
| D8 | `inappropriate ad` |
| D9 | *(expect `ad_details_form`)* → submit |
| D10 | **Nothing to attach** |

### D — Purchases

| # | Action |
|---|--------|
| D11 | `menu` → **Purchases** → **No** (payment not completed) |
| D12 | Read payment-help text → should lead toward human handoff |

---

## Suite E — Break out of guided flow (Runs E1–E10)

**Goal:** User inside guided tree sends off-script text; bot should not dead-end.

Fresh conversation for each sub-case.

| # | Setup | Break-out message | Expected |
|---|-------|-------------------|----------|
| E1 | Menu showing | `how to withdraw?` | FAQ answer (RAG), not forced menu re-prompt only |
| E2 | Inside `missing_reward_form` (don't submit) | `what are coins for?` | FAQ answer via RAG |
| E3 | Inside `missing_reward_form` | `menu` | Main menu reset |
| E4 | Inside `ad_issue_menu` | `how long does withdrawal take?` | FAQ answer |
| E5 | After FAQ answer | `I still need to report a missing reward` | Routes into `missing_reward_form` |
| E6 | Mid-form | `talk to a human` | Immediate handoff (guardrail) |
| E7 | Clarification menu (trigger ambiguous msg like `withdrawal problem`) | Click **Show me the answer** | FAQ from Pinecone |
| E8 | Same clarification | Click **Help with my issue** | Enters guided flow from pending start node |
| E9 | Inside attachment prompt | Empty upload-less message / accidental blank | Re-renders attachment prompt, not main menu |
| E10 | Inside active flow after previous report completed | `yo` | If state was reset to completed/handoff, starts fresh main menu |

**Pass criteria:** Break-out never leaves user with zero bot response. State recovers after `menu`.

---

## Suite F — Gameplay question → LLM path (Runs F1–F3)

| # | Action | Expected |
|---|--------|----------|
| F1 | `hi` → **Gameplay Question** | Submenu: feature vs problem |
| F2 | **I have a question about a feature or how to play** | LLM prompt: "quick overview..." |
| F3 | `how do tournaments work?` | RAG FAQ reply OR guided clarification |

---

## Suite G — Guardrails & handoff (Runs G1–G5)

Use **separate conversations** to avoid polluting guided tests.

| # | Send | Expected flags / behavior |
|---|------|---------------------------|
| G1 | `I want a refund for my purchase` | `billing_dispute` → handoff |
| G2 | `my password is secret123` | `credential_shared` → handoff |
| G3 | `I need to talk to a real person` | `human_requested` → handoff |
| G4 | `I'm going to sue you` | `legal` → handoff |
| G5 | `delete my data under GDPR` | `data_deletion` → handoff |

**Pass criteria:** Public handoff message; private summary; labels applied; conversation status open.

---

## Suite H — Edge cases (Runs H1–H7)

| # | Test | Expected |
|---|------|----------|
| H1 | Send two different texts within 1s | Second may `conversation_debounce` skip |
| H2 | Repeat exact same message id (hard to repro live) | Skip if duplicate — note if observed |
| H3 | `help` mid-flow | Explicit menu reset |
| H4 | Resolve conversation in Chatwoot agent view (if accessible) | Next message shows fresh menu (`chatwoot_resolved` reset) |
| H5 | Upload unsupported/random file type at attachment prompt | Completes report path; bot should not inspect/download file |
| H6 | Upload file while main menu is showing | Should not complete report; should either route via LLM or re-prompt safely |
| H7 | Click old/stale button after state changed | Should not corrupt current state; record observed behavior and execution id |

---

## Suite I — Random real-world exploratory tests (Runs I1–I20+)

**Goal:** Exercise the bot like real customers, not just scripted happy paths. Use fresh conversations for at least half of these. Vary spelling, casing, urgency, incomplete details, and whether the user clicks buttons or types naturally.

### Random prompt pool

Pick 15–25 prompts across these categories, in random order:

| Category | Example customer messages | Expected invariant |
|----------|---------------------------|--------------------|
| Casual start | `yo`, `hey there`, `hello support` | Fresh conversation should show main menu or a safe support greeting; log as UX issue if routed oddly |
| Natural issue | `my reward never came`, `game froze in a tournament`, `purchase went through but nothing showed up` | Guided flow or clarification, not generic menu loop |
| Specific sub-option | `inappropriate ad`, `ad froze`, `black screen after watching ad`, `could not close the ad` | Routes to the right ad intake path, preferably skipping submenu |
| FAQ | `what are coins used for`, `how do I withdraw`, `how long do cashouts take` | RAG answer with no forced intake |
| Ambiguous | `withdrawal problem`, `bonus cash issue`, `tournament question` | Clarification or correct guided path; no confident hallucination |
| Frustrated but safe | `this is annoying`, `your game stole my coins`, `why is this broken` | Collects details or hands off depending severity |
| Human requests | `agent please`, `real person`, `support human now` | Handoff |
| Off-scope | `capital of France`, `write me a poem`, `crypto price today` | Handoff/out-of-scope, no non-ProGolf answer |
| Typos/slang | `i dint get reward`, `ad waz sus`, `purchse done no coins` | Best-effort guided route/clarification |
| Multiturn drift | Start missing reward flow, then ask `what are coins for?`, then `ok back to reward` | RAG answer, then route back into guided flow if requested |

### Random walk recipe

For each random conversation:

1. Start with one prompt from the pool.
2. If the bot asks for a form, fill it with realistic but fake details.
3. At least five times, intentionally go off-script mid-flow with an FAQ, greeting, or human request.
4. At least three times, upload a small image/file at the attachment prompt.
5. At least three times, click **Nothing to attach**.
6. Record the exact transcript, execution ids, and whether the invariant held.

**Pass criteria:** No silent drops, no unexpected main menu resets inside active guided flows, no generic LLM answer pretending to be RAG, and every completed report either resolves via confident RAG or reaches handoff.

---

## Execution order (when approved)

Run suites in this order to minimize cross-talk:

1. **A** (entry) — ~5 runs  
2. **B** (FAQ) — ~6 runs  
3. **C** (RAG completion) — ~4 runs  
4. **C2** (attachments) — ~7 runs  
5. **E** (break-out) — ~10 runs, fresh conv each sub-case  
6. **D** (guided paths) — ~12 runs  
7. **F** (gameplay LLM) — ~3 runs  
8. **G** (guardrails) — ~5 runs, fresh conv each  
9. **H** (edge) — ~7 runs  
10. **I** (random exploratory) — 20+ runs  

**Estimated total:** ~80+ customer messages → ~80+ webhook runs (± skips/debounces).

---

## Final report format

After execution, deliver:

```
Workflow: Chatwoot Guided Flow + RAG Bot (Agent Bot webhook)
Workflow ID: <from MCP>
Test window: <start ISO> – <end ISO>
Starting run #: <baseline+1 or first execution id>
Ending run #: <last execution id / count>

Summary: X passed / Y failed / Z skipped (debounce/dup)

Per-suite table: suite | runs | pass/fail | notes
Failed runs: execution id + node + observed vs expected
Random exploratory transcript notes: prompt | expected invariant | observed | execution id
Screenshots: widget state for any failure
```

---

## Risks & assumptions

- Widget on csr.progolf.cash is wired to `chatwoot-guided-with-rag` webhook and the intended V3 workflow version is active/published before browser testing.
- Pinecone index `pro-golf-support` populated; OpenAI credentials valid.
- Bot reply latency 5–30s on RAG turns (LLM + retrieval).
- Cannot reliably trigger duplicate `message.id` from browser — H2 optional.
- Resolving conversation (H4) may need agent dashboard access; skip if unavailable.
- Upload tests should use small non-sensitive dummy files only.

---

## Approval

Reply **go ahead** (or edits to this plan) before live browser + MCP test run begins.
