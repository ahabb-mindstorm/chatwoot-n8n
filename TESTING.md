# Manual QA matrix

Run after importing `workflows/chatwoot-support-bot.json` into n8n and wiring env vars.

| Case | Payload / action | Expected |
|------|------------------|----------|
| Loop prevention | Simulate `message_created` with `sender.type != contact` OR `message_type` outgoing OR `private: true` | Webhook `{ ok:true, ignored:not_customer_incoming }`, no Chatwoot API calls beyond prior nodes |
| Human handoff phrase | Ask model (or fixture) returning `needs_human: true` or `risk_flags` includes `human_requested` | Labels + private note + `status:open`, no public reply |
| Unknown / low confidence | Prompt that yields `<0.75` confidence | Escalation path |
| LLM outage | Break `OPENAI_API_KEY` temporarily | Escalate with `[n8n bot v1]` private note referencing tool_failed |
| Duplicate delivery | Replay same Chatwoot `message.id` twice within `IDEMPOTENCY_WINDOW_MS` | Second `{ ok:true, ignored:duplicate_message }` |
| Burst typing | Two different message ids inside `CONVERSATION_DEBOUNCE_MS` | Second may `{ ignored:conversation_debounce }` |

Tip: activate workflow, use Chatwoot test inbox, watch n8n Executions + Chatwoot conversation.
