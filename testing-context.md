# Testing context & challenges (v3 RAG guided bot)

Companion to `testing.md`. Captures environment, tooling constraints, and issues observed during the first live browser + n8n MCP test pass (2026-06-04).

---

## What we are testing

| Item | Value |
|------|--------|
| UI | [ProGolf withdrawal help article](https://csr.progolf.cash/hc/withdrawl/articles/1778579420-progolf) — Chatwoot widget, bottom-right |
| Workflow file | `workflows/chatwoot-bot-with-rag-v3.json` |
| Live n8n workflow id | `pi1FV25pGTEu4rwm` |
| Webhook path | `chatwoot-guided-with-rag` |
| Pinecone index | `pro-golf-support` |
| State storage | Chatwoot `custom_attributes.n8n_guided_flow` |

The bot is a **hybrid router**: deterministic guided tree (options / forms / text) plus **RAG Guided Agent** for free-text FAQ, routing, clarification, completion checks, and handoff.

---

## How runs are counted

**Definition (from plan):** one customer message or one interactive submission (button click, form submit) → one Chatwoot webhook → one n8n execution = **one run**.

**In practice:**

- Chatwoot often emits **multiple webhook events** for a single user action (`message_created`, `message_updated` for `input_select` / `form`, status changes). A single click can produce several execution ids in quick succession (e.g. runs 1071–1077 for one handoff + overlapping `hello`).
- **Skipped** executions still count as runs: duplicate idempotency, conversation debounce, non-customer events → early exit via `Respond OK (skip|dup)`.
- **Baseline before test:** execution **1048**. First test-window runs started at **1049**; last observed **1106** (~58 executions, fewer distinct user intents than 58).

**MCP workflow:**

1. `search_executions` with `workflowId: pi1FV25pGTEu4rwm` → baseline id.
2. Run tests; wait for bot reply between sends.
3. `search_executions` with `startedAfter` = test start → ending id.
4. Failures: `get_execution` with `includeData: true`, nodes `Guided Flow Router`, `Evaluate RAG Answer`, `Respond OK (*)`.

---

## Browser / widget automation challenges

### Chatwoot lives in an iframe

The widget is **`#chatwoot_live_chat_widget`** pointing at `https://csr.progolf.cash/widget?website_token=...`. The host page accessibility tree does **not** expose chat controls; automation must use **CDP `Runtime.evaluate`** on `iframe.contentDocument`.

Cursor browser snapshot/refs **do not reach inside the iframe** reliably. Coordinate clicks and ref-based `browser_click` are insufficient for message send and option clicks.

### Starting a conversation

Flow: open widget → **Start Conversation** → full chat view with `textarea[placeholder="Type your message"]`.

Send pattern that worked:

1. Focus main textarea (not form fields).
2. Set value via `HTMLTextAreaElement.prototype` setter (Vue reactivity).
3. Dispatch `InputEvent('input', { inputType: 'insertText' })`.
4. Click `button[type="submit"].ml-1` (send), **not** the emoji picker button.

Enter key alone did not reliably submit.

### Preview bubble vs full chat

When the user is not focused on the expanded widget, replies appear in a **collapsed preview** (“See new messages”) instead of the full transcript. In that state:

- `textarea[placeholder="Type your message"]` may be **missing**.
- Automation reports `no textarea` even though the bot replied.

**Mitigation:** click “See new messages” or keep full chat open before every send; verify textarea exists after each bot reply.

### Form fields steal keyboard input

If a guided **form** is on screen, typing without focusing the main textarea can fill a **form field** instead of sending a chat message.

**Observed:** `menu` typed into “Did you miss out on any other rewards?” instead of triggering menu reset.

**Mitigation:** always `querySelector('textarea[placeholder="Type your message"]')`, focus it, then send.

### Resetting conversation state

| Method | Behavior |
|--------|----------|
| `menu` / `help` / `start` | Explicit guided reset to main menu (when sent as chat message, not form input). |
| `hi` / `hello` at **main** node | Re-render main menu (not deep-flow reset). |
| `hi` / `hello` **inside** active flow (non-options node) | Re-prompt current step, not main menu. |
| End Conversation button | Not always present after handoff; title selector failed in some states. |
| iframe `src` reset (drop `cw_conversation`) | Fresh widget session; requires Start Conversation again. |

**Risk:** rapid iframe resets triggered **“We will be back as soon as possible” / Retry later** — inbox appeared offline and blocked further sends.

### Timing

| Setting | Default | Impact |
|---------|---------|--------|
| `CONVERSATION_DEBOUNCE_MS` | 2000 | Two free-text messages &lt;2s apart → second may skip. |
| RAG agent path | ~5–30s | Need ≥20–25s wait after FAQ / free-text before asserting failure. |
| Interactive clicks | — | Debounce bypassed; can click faster than typing. |

Plan says ≥3s between free-text messages; RAG turns often need longer.

### Attachments

Not exercised in the first pass (Suite C2 blocked). Plan requires: wait for upload bubble, then bot reply, before next action. File input is `input[type="file"]` (often hidden) on attachment prompt nodes.

---

## Product / workflow issues found

### 1. FAQ wrongly escalates to handoff (run **1082**)

**Input:** `how to withdraw?` (free text; guided router → `unmatched_options_text` → RAG).

**RAG agent output:**

- `route: faq`
- Good withdrawal steps in `answer`
- `confidence: 1`
- `knowledge_used: ["1458"]`
- **`rag_answerable: false`**

**Evaluate RAG Answer** requires `rag_answerable === true` and non-empty `knowledge_used` for `hasRetrievalProof`. With `rag_answerable: false`, evaluator sets `shouldHandoff` via `low_confidence_or_bad_faq=true` → **`action: handoff`** even though the answer is correct.

**User-visible result:** withdrawal FAQ text still shown (handoff path includes `publicAnswer`), but conversation also gets labels (`bot_escalated`), private note, and open status — **wrong for a clean FAQ reply**.

**Likely fix area:** agent prompt/schema (`rag_answerable` when retrieval used) and/or evaluator guard in `Evaluate RAG Answer`.

### 2. Handoff copy on menu “Talk to a human”

Clicking **Talk to a human** correctly routes to guided `human` node (run **1071**). Public message uses generic outside-scope handoff text rather than a human-queue-specific ack. May be intentional but reads oddly when user explicitly chose that menu option.

### 3. Overlapping messages in one conversation

Sending `hello` while handoff for **Talk to a human** was still processing caused an extra main-menu re-render before handoff text. Real users can do this too; worth deciding if handoff should suppress further guided replies.

---

## Suite coverage vs plan (first pass)

| Suite | Planned runs | First-pass status |
|-------|--------------|-------------------|
| A Entry/menu | ~5 | Mostly complete |
| B FAQ | ~6 | Partial (withdrawal FAQ/timing; coins/out-of-scope incomplete) |
| C RAG → guided | ~4 | Started, not finished |
| C2 Attachments | ~7 | Not run |
| D Guided paths | ~12 | Partial (via Suite A) |
| E Break-out | ~10 | Partial (E1, E6) |
| F Gameplay LLM | ~3 | Not run |
| G Guardrails | ~5 | Blocked (widget offline) |
| H Edge | ~7 | Not run |
| I Exploratory | 20+ | Not run |

**Blockers for full pass:** widget offline state after aggressive session resets, preview-bubble UI, long RAG latency, ~80+ sequential messages with fresh conversations.

---

## Recommendations for the next test pass

1. **Fix or patch** `rag_answerable` / evaluator before re-running FAQ suite (B).
2. **Keep one browser session** — avoid rapid iframe `src` resets; use `menu` or agent resolve for clean state when possible.
3. **Helper script** (Playwright or stable CDP helpers): `startConversation`, `sendChat`, `clickOption`, `fillForm`, `waitForAgentReply`, `expandWidget`.
4. **Assert on n8n node output**, not only widget text: `action`, `guidedAction`, `route`, `Respond OK (*)` body.
5. **Fresh conversation** per polluting suite (G guardrails, E break-out subcases) without nuking iframe repeatedly.
6. **Confirm inbox online** in Chatwoot before long runs; offline banner stops all sends.
7. **Log mapping:** user action → message id (if visible in execution payload) → execution id → pass/fail.

---

## Useful execution ids (first pass)

| Run | Scenario | Outcome |
|-----|----------|---------|
| **1050** area | `hi` → main menu | Guided reply ✓ |
| **1071** | Click Talk to a human | Handoff ✓ |
| **1082** | `how to withdraw?` | FAQ content ✓ but handoff route ✗ (bug) |
| **1082** area | `how long does withdrawal take?` | Timing FAQ in widget ✓ |

---

## Related files

- `testing.md` — full test plan and approval gate
- `TESTING.md` — older manual QA matrices for other workflow variants
- `workflows/chatwoot-bot-with-rag-v3.json` — workflow under test
