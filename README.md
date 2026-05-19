# Chatwoot + n8n conversational support bot

Self-hosted Chatwoot **Agent Bot** posts webhooks into n8n. n8n normalizes payloads, loads Chatwoot context, fetches a JSON guided-flow tree, renders Chatwoot options/forms/text from that tree, routes custom questions to an AI Agent, applies a deterministic **Safety Gate**, then either **public replies** or **hands off** (labels, private summary, PATCH conversation).

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

### Handoff routing

Populate optional `CHATWOOT_ESCALATION_TEAM_ID` / `CHATWOOT_ESCALATION_ASSIGNEE_ID` for PATCH assigns.

### AI Agent node

Workflow includes an n8n LangChain **AI Agent** node. Configure OpenAI credentials in n8n after import. The Agent handles guided-flow `llm` nodes and returns strict JSON; direct `text`, `options`, and `form` nodes are handled before the LLM. The downstream Safety Gate enforces final reply/handoff.

### Guided support flow

The workflow uses **Fetch Guided Flow** as a temporary API stand-in. It returns a static JSON tree shaped like the future portal/API response. Replace this Code node with an HTTP Request later, as long as the router still receives `guidedFlow`.

Flow schema:

```json
{
  "version": 1,
  "entry": "main",
  "nodes": {
    "main": {
      "type": "options",
      "prompt": "What can I help you with?",
      "options": [
        { "id": "lost_reward", "text": "Lost Reward", "target": "lost_reward_form" }
      ]
    },
    "lost_reward_form": {
      "type": "form",
      "prompt": "Tell us about the lost reward.",
      "fields": [
        { "id": "lost_location", "label": "Where did you lose it?", "type": "text", "required": true }
      ],
      "submitTarget": "human"
    }
  }
}
```

Supported node types:

- `options` renders Chatwoot `input_select`.
- `form` renders Chatwoot `form`.
- `text` renders a public message, or text plus the next options node when `next` points to `options`.
- `llm` enters the AI Agent path.
- `human` enters the handoff path.

Guided state is stored on conversation custom attributes under `n8n_guided_flow` via `POST /api/v1/accounts/:account_id/conversations/:conversation_id/custom_attributes`. State includes `flow_version`, `current_node`, `path`, `form_data`, `last_action`, and `updated_at`.

The router reads `content_attributes.submitted_values` from Chatwoot `input_select` and `form` submissions. It also accepts plain text fallback values that match current option IDs or labels.

### FAQ source

Starter FAQ lives in `knowledge/faq.json`. Duplicate content into workflow node **Build Knowledge Pack** (`knowledgePack` array); n8n Code nodes cannot read repo files unless you mount them and swap in a filesystem node yourself.

Fast MVP passes the full small FAQ list to the LLM. This is fine while docs are compact. Later, replace **Build Knowledge Pack** with vector retrieval or an AI Agent tool like `search_knowledge_base`.

### Production notes

| Concern | Where |
|--------|--------|
| Idempotency + debounce | `Idempotency & Debounce` node + `$getWorkflowStaticData('global')` |
| Repeated failed turns | `Failed Turn Tracker` node + `FAILED_TURN_THRESHOLD` |
| Guided-flow state | Chatwoot conversation custom attributes: `n8n_guided_flow` |
| Guided-flow source | `Fetch Guided Flow` Code node; replace later with API HTTP Request |
| n8n runtime persistence | Compose volume `n8n_data`; back up `.n8n` dir regularly |
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

## RAG guided bot (Pinecone)

Separate workflow: `workflows/chatwoot-rag-guided-bot.json`.

1. Import and activate it in n8n (in addition to or instead of the static guided bot).
2. Configure **OpenAI** and **Pinecone** credentials on **Embeddings OpenAI**, **Pinecone Vector Store**, and **OpenAI Chat Model** nodes.
3. Set `PINECONE_INDEX`, optional `PINECONE_NAMESPACE`, `RAG_TOP_K`, `RAG_MIN_SCORE`, and `OPENAI_EMBEDDING_MODEL` in `.env` (embedding model must match what you used when uploading vectors).
4. Populate the index from [`rag/`](rag/):

```bash
# Requires OPENAI_API_KEY and PINECONE_API_KEY in .env
npm install
npm run rag:upsert
```

Creates the index if missing (default name `pro-golf-support`), chunks each doc on `##` headings, embeds with `OPENAI_EMBEDDING_MODEL`, and upserts with planner metadata (`doc_id`, `topic`, `game_contexts`, `tips`, etc.). Use `npm run rag:upsert -- --recreate` to delete and recreate the index.

5. Point a Chatwoot Agent Bot `outgoing_url` to `{WEBHOOK_URL}webhook/chatwoot-rag-guided-bot`.

Each customer message: embed query → Pinecone top-k → **Flow Planner** JSON (prompt, `input_select` options, tips) → public reply, or handoff when retrieval score is below `RAG_MIN_SCORE` or the planner marks `in_scope: false`.

### Pinecone document metadata (recommended)

When you upload support articles to Pinecone, include metadata the planner can use for game-specific options:

```json
{
  "doc_id": "lost-reward-overview",
  "topic": "lost_reward",
  "title": "Lost reward",
  "body": "Full troubleshooting text...",
  "game_contexts": ["main_screen", "tournament", "daily_challenge"],
  "tips": ["Check reward inbox", "Force-close and reopen"]
}
```

Guided state is stored on the conversation under custom attribute `n8n_guided_flow` (`flow_version: 2`, `mode: rag_guided`).

Logic mirrors [`lib/ragScope.mjs`](lib/ragScope.mjs) and [`lib/flowPlanner.mjs`](lib/flowPlanner.mjs).

## Tests

Requires Node ≥18:

```bash
npm test
```

Manual matrix: [`TESTING.md`](TESTING.md).

## Troubleshooting

- Labels API 422 → titles must exist beforehand.  
- Empty transcript → LIST messages query returns different envelope; tweak parsing in Build Prompt Code.  
- OpenAI refuses JSON → Temperature already low; widen system prompt minimally.  
- Guided menu not rendering → confirm channel supports Chatwoot `input_select`; text fallback still works if customer sends the option value manually.
- Guided form not rendering → confirm channel supports Chatwoot `form`; web widget is the safest target.
- Flow route fails → check `Fetch Guided Flow` has valid `entry`, `nodes`, and targets that exist.

## License

MIT (project scaffold – adjust as needed).
