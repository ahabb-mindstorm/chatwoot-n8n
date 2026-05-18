# Manual QA matrix

Run after importing `workflows/chatwoot-support-bot.json` into n8n and wiring env vars.

| Case | Payload / action | Expected |
|------|------------------|----------|
| First entry guided menu | Send `hi`, `hello`, `help`, or an empty first customer message | Public `input_select` menu with reset password, billing, status, custom question, and human options; conversation custom attributes include `n8n_guided_flow.mode=menu` |
| FAQ option | Select `Reset password`, `Billing and invoices`, or `Outage or slowness` from the menu | Public deterministic answer from the knowledge pack plus resolution prompt; `n8n_guided_flow.step=resolution_check` |
| Resolved option | Select `Yes, resolved` after a guided answer | Public closing message; `n8n_guided_flow.mode=completed`, no LLM call |
| Unresolved option | Select `No, talk to a human` after a guided answer | Existing escalation path with `guided_flow` / `guided_unresolved` labels and private note |
| Custom question prompt | Select `Ask a custom question` | Bot asks for free-text issue and stores `n8n_guided_flow.mode=awaiting_custom` |
| Custom LLM loop | After custom prompt, send a free-text issue | Message routes through AI Agent, Safety Gate, Failed Turn Tracker, and stores updated `llm_turns` |
| Text fallback | Send `1`, `billing`, `status`, `custom`, `human`, `yes`, `no`, or `menu` instead of clicking UI | Router treats text as matching guided option |
| Loop prevention | Simulate `message_created` with `sender.type != contact` OR `message_type` outgoing OR `private: true` | Webhook `{ ok:true, ignored:not_customer_incoming }`, no Chatwoot API calls beyond prior nodes |
| Human handoff phrase | Ask model (or fixture) returning `needs_human: true` or `risk_flags` includes `human_requested` | Labels + private note + `status:open`, no public reply |
| Unknown / low confidence | Prompt that yields `<0.75` confidence | Escalation path |
| LLM outage | Break `OPENAI_API_KEY` temporarily during custom mode | Escalate with `[n8n bot v2]` private note referencing `tool_failed` and guided state |
| Duplicate delivery | Replay same Chatwoot `message.id` twice within `IDEMPOTENCY_WINDOW_MS` | Second `{ ok:true, ignored:duplicate_message }` |
| Burst typing | Two different message ids inside `CONVERSATION_DEBOUNCE_MS` | Second may `{ ignored:conversation_debounce }` |

Tip: activate workflow, use Chatwoot test inbox, watch n8n Executions + Chatwoot conversation.
