# Chatwoot + n8n conversational support bot

Self-hosted Chatwoot **Agent Bot** posts `message_created` webhooks into n8n. n8n normalizes payloads, loads Chatwoot context, routes intent, retrieves FAQ/tool context, asks an AI Agent for strict JSON, applies a deterministic **Safety Gate**, then either **public replies** or **escalates** (labels, private summary, PATCH conversation).

## Prerequisites

- Chatwoot (Docker) with account API token for `/api/v1/accounts/:id/agent_bots`  
- Optional platform token for `/platform/api/v1/agent_bots`  
- Labels `bot_escalated` + `n8n_bot` created in Chatwoot (Settings → Labels)  
- HTTPS `WEBHOOK_URL` reachable from Chatwoot (avoid `localhost` unless tunneled)  
- OpenAI API key  

## Quick start

1. `cp .env.example .env` and fill Chatwoot + OpenAI vars.  
2. `docker compose up -d` – n8n on port `5678` (persisted volume `n8n_data`).  
3. Complete n8n onboarding, import `workflows/chatwoot-support-bot.json`, activate.  
4. Point Chatwoot Agent Bot **`outgoing_url`** to `{WEBHOOK_URL}webhook/chatwoot-support-bot` (slash rules: trailing slash matters for `WEBHOOK_URL` env).  
5. Run `bash scripts/setup-agent-bot.sh` **or** create bot in UI and paste the same URL.  
6. Use `CHATWOOT_API_ACCESS_TOKEN` that can create agent bots, attach inbox bots, and post conversation messages for the account.  

### Webhook secret (optional)

Set `CHATWOOT_WEBHOOK_SECRET` in `.env` and terminate TLS in front of n8n with a tiny proxy that injects `X-Webhook-Secret` on allowed paths. Chatwoot cannot set arbitrary headers natively — only use where you terminate webhooks behind your edge.

### Escalation routing

Populate optional `CHATWOOT_ESCALATION_TEAM_ID` / `CHATWOOT_ESCALATION_ASSIGNEE_ID` for PATCH assigns.

### AI Agent node

Workflow includes an n8n LangChain **AI Agent** node. Configure OpenAI credentials in n8n after import. The Agent must return strict JSON; the downstream Safety Gate enforces final reply/escalation.

### FAQ source

Starter FAQ lives in `knowledge/faq.json`. Duplicate content into workflow node **Build Prompt & OpenAI Body** (`faqItems` array); n8n Code nodes cannot read repo files unless you mount them and swap in a filesystem node yourself.

### Production notes

| Concern | Where |
|--------|--------|
| Idempotency + debounce | `Idempotency & Debounce` node + `$getWorkflowStaticData('global')` |
| Repeated failed turns | `Failed Turn Tracker` node + `FAILED_TURN_THRESHOLD` |
| Persistence | Compose volume `n8n_data`; back up `.n8n` dir regularly |
| Metrics | Subscribe to Chatwoot webhooks separately or scrape n8n execution logs |

## Scripts

```bash
export CHATWOOT_BASE_URL=https://chat.example.com
export CHATWOOT_ACCOUNT_ID=1
export CHATWOOT_INBOX_ID=3
export CHATWOOT_API_ACCESS_TOKEN=xxxxx
export N8N_AGENT_WEBHOOK_URL=https://n8n.example.com/webhook/chatwoot-support-bot

bash scripts/setup-agent-bot.sh
```

If `set_agent_bot` route 404 on your Chatwoot version, attach manually: Inbox settings → Agent Bot → pick bot.

Optional platform mode:

```bash
export CHATWOOT_AGENT_BOT_API=platform
export CHATWOOT_PLATFORM_ACCESS_TOKEN=platform-token
bash scripts/setup-agent-bot.sh
```

## Tests

Requires Node ≥18:

```bash
node --test tests/workflow-and-logic.test.mjs
```

Manual matrix: [`TESTING.md`](TESTING.md).

## Troubleshooting

- Labels API 422 → titles must exist beforehand.  
- Empty transcript → LIST messages query returns different envelope; tweak parsing in Build Prompt Code.  
- OpenAI refuses JSON → Temperature already low; widen system prompt minimally.  

## License

MIT (project scaffold – adjust as needed).
