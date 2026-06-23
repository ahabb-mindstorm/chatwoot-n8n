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
2. `docker compose up -d` – n8n on port `5678` and Postgres on host port `5433` by default (container still listens on `5432` internally; set `POSTGRES_PORT` if you need a different host mapping). Volumes: `n8n_data`, `postgres_data`.  
3. Apply bot-state schema:
   ```bash
   docker compose exec -T postgres psql -U "${POSTGRES_USER:-chatwoot_bot}" -d "${POSTGRES_DB:-chatwoot_bot}" < migrations/001_bot_support_state.sql
   docker compose exec -T postgres psql -U "${POSTGRES_USER:-chatwoot_bot}" -d "${POSTGRES_DB:-chatwoot_bot}" < migrations/006_idempotency_debounce.sql
   docker compose exec -T postgres psql -U "${POSTGRES_USER:-chatwoot_bot}" -d "${POSTGRES_DB:-chatwoot_bot}" < migrations/007_agent_bot_kill_switch.sql
   ```
   From the host (default mapped port `5433`):
   ```bash
   psql -h localhost -p "${POSTGRES_PORT:-5433}" -U chatwoot_bot -d chatwoot_bot -f migrations/001_bot_support_state.sql
   ```
4. Complete n8n onboarding, import a workflow JSON, activate:
   - **Legacy (Chatwoot-stored guided state):** `workflows/chatwoot-support-bot.json` → webhook `chatwoot-support-bot`
   - **Hybrid guided + RAG:** `workflows/chatwoot-guided-with-rag.json` → webhook `chatwoot-guided-with-rag`
   - **Postgres-backed (recommended):** `workflows/chatwoot-support-bot-postgres.json` → webhook `chatwoot-support-bot-postgres`
5. In n8n, create a **Postgres** credential named `Bot Postgres` (host `postgres`, db/user/password from `.env`) and attach it to all Postgres nodes (`__REPLACE_ME__` placeholders). Configure OpenAI + Pinecone credentials on AI/RAG nodes.
6. Point Chatwoot Agent Bot **`outgoing_url`** to `{WEBHOOK_URL}webhook/<workflow-path>` (slash rules: trailing slash matters for `WEBHOOK_URL` env).  
7. Run `bash scripts/setup-agent-bot.sh` **or** create bot in UI and paste the same URL.  
8. Use `CHATWOOT_API_ACCESS_TOKEN` that can create agent bots, attach inbox bots, update labels/status, and post private/internal messages for the account. Set `CHATWOOT_AGENT_BOT_ACCESS_TOKEN` to the Agent Bot access token so public bot replies are authored by the bot instead of a human agent.  

### Chatwoot webhook authentication

The production PGVector workflow verifies Chatwoot's signed webhook headers against the exact raw request body before any database, AI, or Chatwoot side effect runs. Configure the Agent Bot secret and restrict the accepted account and inbox:

```bash
CHATWOOT_WEBHOOK_SECRET=<the Agent Bot secret from Chatwoot>
CHATWOOT_ACCOUNT_ID=2
CHATWOOT_INBOX_ID=3
CHATWOOT_WEBHOOK_AUTH_ENFORCED=true
```

Restart n8n after changing its environment. Keep `CHATWOOT_WEBHOOK_AUTH_ENFORCED=false` only during rollout; compatibility mode accepts unsigned traffic. Strict mode rejects missing, malformed, stale (over five minutes), incorrectly signed, or wrong-account/inbox requests with HTTP 401.

### n8n execution queue and hung-run recovery

The bot's PostgreSQL tables are the durable conversation queue and side-effect ledger. For process-level isolation, `docker-compose.queue.yml` additionally runs n8n in queue mode with Redis, PostgreSQL-backed n8n metadata, and two worker processes by default.

Queue defaults are deliberately aligned with the bot lease:

- Each worker accepts five concurrent executions, so one hung execution doesn't block the main n8n process.
- Workflow executions stop after 240 seconds, before the bot's 300-second conversation lease expires.
- AI calls stop after 180 seconds.
- Redis detects stalled jobs and retries them once. The bot's idempotency/effect ledger prevents retries from repeating completed Chatwoot effects.
- Redis uses append-only persistence and isn't published to the host network.
- `N8N_SECURE_COOKIE` defaults to `false` in queue mode so the editor works over plain HTTP. Set it to `true` once n8n is behind HTTPS.

The current installation must be migrated from SQLite to PostgreSQL before queue mode can start. Put the existing n8n encryption key and a new strong Redis password in `.env`, then run:

```bash
./scripts/migrate-n8n-to-queue.sh --preflight
./scripts/migrate-n8n-to-queue.sh --apply  # run during a maintenance window
```

The script stops n8n, backs up its data volume, exports all entities, creates the dedicated n8n database, imports the entities, then starts Redis, the main process, and two workers. It restarts the untouched SQLite service if migration fails before queue mode starts. To roll back after a successful migration:

```bash
docker compose -f docker-compose.queue.yml down
docker compose up -d n8n
```

See n8n's [queue-mode documentation](https://docs.n8n.io/hosting/scaling/queue-mode/) and [database migration commands](https://docs.n8n.io/hosting/cli-commands/).

### Handoff routing

Populate optional `CHATWOOT_ESCALATION_TEAM_ID` / `CHATWOOT_ESCALATION_ASSIGNEE_ID` for PATCH assigns.

### AI Agent node

Workflow includes an n8n LangChain **AI Agent** node. Configure OpenAI credentials in n8n after import. The Agent handles guided-flow `llm` nodes and returns strict JSON; direct `text`, `options`, and `form` nodes are handled before the LLM. The downstream Safety Gate enforces final reply/handoff.

### Guided support flow

The V3 workflow uses **Fetch Guided Flow** to load the published flow from the support frontend visual creator when `GUIDED_FLOW_API_URL` is set. It calls:

```text
${GUIDED_FLOW_API_URL}/api/workflows/current
```

Publishing a workflow in the visual creator makes it the single live workflow; publishing another workflow moves the previous live workflow back to draft. If the current live workflow is unpublished, `/api/workflows/current` returns no workflow and V3 routes customers to handoff instead of rendering stale embedded menus. If the API URL is not configured or the fetch fails unexpectedly, the node falls back to the embedded V3 JSON tree so support does not go dark.

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
- `upload` renders a prompt and waits for the next incoming Chatwoot message with `attachments`; use `submitTarget`/`next` after upload and optional `skipTarget` when user says `skip` or `nothing to attach`.
- `text` renders a public message, or text plus the next options node when `next` points to `options`.
- `llm` enters the AI Agent path.
- `human` enters the handoff path.

Guided state is stored on conversation custom attributes under `n8n_guided_flow` via `POST /api/v1/accounts/:account_id/conversations/:conversation_id/custom_attributes`. State includes `flow_version`, `current_node`, `path`, `form_data`, `last_action`, and `updated_at`.

### Postgres-backed support bot

Workflow: `workflows/chatwoot-support-bot-postgres.json` (webhook `chatwoot-support-bot-postgres`).

Architecture: **Chatwoot AgentBot → n8n Router → active flow check → guided flow / FAQ (RAG) / human handoff / clarification**.

| Concern | Where |
|--------|--------|
| Bot state, flow progress, submissions, audit, idempotency | Local Postgres (`bot_conversation_state`, `bot_flow_submissions`, `bot_audit_events`) |
| Agent-visible metadata only | Chatwoot `custom_attributes`: `active_flow`, `last_intent`, `case_type`, `bot_status`, `current_step`, `agent_summary` |

Routing:

1. Normalize incoming Chatwoot webhook payload.
2. Load conversation state from Postgres by `account_id`, `conversation_id`, `contact_id`.
3. If an active unresolved guided flow exists → **Continue Guided Flow** (static JSON tree from **Fetch Guided Flow**).
4. Else → **Classify Message** (AI Agent + **Classifier Structured Output Parser** + **Validate Classifier Output**) → `guided_flow` | `faq` | `human_handoff` | `clarification`.
5. Persist state/audit to Postgres, update lightweight Chatwoot attributes, send reply or hand off (labels, private note, assign team).

Fail-closed: Postgres errors, classifier parser/validation failures, or weak RAG confidence → **Human Handoff**.

Regenerate workflow after editing `scripts/generate-postgres-workflow.mjs`:

```bash
npm run workflow:generate-postgres
```

The router reads `content_attributes.submitted_values` from Chatwoot `input_select` and `form` submissions. It also accepts plain text fallback values that match current option IDs or labels, and stores attachment metadata when an active `upload` node receives a Chatwoot message with `attachments`.

### FAQ source

Starter FAQ lives in `knowledge/faq.json`. Duplicate content into workflow node **Build Knowledge Pack** (`knowledgePack` array); n8n Code nodes cannot read repo files unless you mount them and swap in a filesystem node yourself.

Fast MVP passes the full small FAQ list to the LLM. This is fine while docs are compact. Later, replace **Build Knowledge Pack** with vector retrieval or an AI Agent tool like `search_knowledge_base`.

### Production notes

| Concern | Where |
|--------|--------|
| Idempotency + debounce | `bot_inbound_events`, `bot_conversation_leases`, and `bot_outbound_effects`; two-second quiet-window batching with minute recovery |
| Repeated failed turns | `FAILED_TURN_THRESHOLD` (legacy tracker; Postgres bot fail-closed on low confidence) |
| Guided-flow state | Legacy: Chatwoot `n8n_guided_flow`; Postgres bot: `bot_conversation_state.flow_state` |
| Guided-flow source | `Fetch Guided Flow` Code node; replace later with API HTTP Request |
| n8n runtime persistence | Compose volume `n8n_data`; back up `.n8n` dir regularly |
| Bot DB persistence | Compose volume `postgres_data`; run migrations on upgrade |
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

## Hybrid Guided + RAG Bot (Pinecone)

Workflow: `workflows/chatwoot-guided-with-rag.json`.

This combines the static guided menu from `workflows/chatwoot-support-bot.json` with Pinecone-backed RAG. New conversations go straight to the guided menu, including **Ask something else**. After the customer picks that option, later messages stay in LLM/RAG mode while Pinecone retrieval is in scope; low confidence, missing context, unsafe topics, or `needs_human` from the model hand off to a human.

Configure **OpenAI** and **Pinecone** credentials on **Embeddings OpenAI**, **Pinecone Vector Store**, and **OpenAI RAG Model** nodes. Point Chatwoot Agent Bot `outgoing_url` to `{WEBHOOK_URL}webhook/chatwoot-guided-with-rag`.

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

**Helpshift CSV export** (e.g. `en_faqs.csv` + `en_sections.csv`):

```bash
npm run rag:export-helpshift       # write rag/helpshift/*.md (94 published FAQs)
npm run rag:upsert-helpshift:dry   # preview chunk counts
npm run rag:upsert-helpshift -- \
  --faqs /path/to/en_faqs.csv \
  --sections /path/to/en_sections.csv
# Full replace: npm run rag:upsert-helpshift -- --recreate
```

Each published FAQ becomes one or more vectors (`helpshift-faq-{id}--{slug}`). HTML is stripped; `topic`, `game_contexts`, and `tips` are inferred from title/body for the Flow Planner.

5. Point a Chatwoot Agent Bot `outgoing_url` to `{WEBHOOK_URL}webhook/chatwoot-rag-guided-bot`.

Each customer message: embed query → Pinecone top-k → **Flow Planner** JSON (prompt, `input_select` options, tips) → public reply, or handoff when retrieval score is below `RAG_MIN_SCORE` or the planner marks `in_scope: false`.

## PGVector staging RAG

The active `ProGolf Support Bot` should be cloned before testing pgvector. Keep the production workflow untouched and use a staging webhook such as `progolf-support-bot-pgvector-test`.

1. Apply `migrations/002_progolf_pgvector.sql` to the Chatwoot Postgres database.
2. Create a dedicated Postgres credential in n8n for the Chatwoot DB role, with `search_path` set to `progolf_support, public`.
3. Preview Helpshift ingestion:

```bash
npm run rag:upsert-pgvector:dry -- \
  --faqs /path/to/en_faqs.csv \
  --sections /path/to/en_sections.csv
```

4. Upsert into `progolf_support.progolf_faq_vectors`:

```bash
npm run rag:upsert-pgvector -- \
  --faqs /path/to/en_faqs.csv \
  --sections /path/to/en_sections.csv \
  --prune-stale
# Full replace: npm run rag:upsert-pgvector -- --recreate
```

The PGVector table uses n8n-compatible columns (`id`, `text`, `metadata`, `embedding`). Runtime retrieval uses n8n's Postgres PGVector Store node in `retrieve-as-tool` mode, connected to the existing OpenAI embeddings node. Do not switch Chatwoot's Agent Bot webhook to the staging workflow until retrieval and QA behavior have been verified.


### Chatwoot Help Center to PGVector sync

Workflow: `workflows/progolf-chatwoot-faq-to-pgvector-sync.sdk.js` (`ProGolf Chatwoot FAQ to PGVector Sync`).

Fetches published Help Center articles via the Chatwoot Help Center API, embeds them with OpenAI, deletes stale `metadata.source = "chatwoot"` vectors, and upserts into `progolf_support.progolf_faq_vectors`. Generated support playbooks in the same table are preserved.

Regenerate the SDK workflow after editing `scripts/generate-chatwoot-pgvector-sync-workflow.mjs`, `scripts/n8n-templates/fetch-chatwoot-articles.js`, or `scripts/lib/chatwoot-article-chunks.mjs`:

```bash
npm run workflow:generate-chatwoot-pgvector-sync
npm run workflow:deploy-chatwoot-pgvector-sync-via-mcp
```

CLI equivalent:

```bash
npm run rag:upsert-chatwoot-pgvector:dry
npm run rag:upsert-chatwoot-pgvector
# Optional portal filter in .env: CHATWOOT_PORTAL_SLUG=withdrawl
```

Required n8n environment:

```bash
CHATWOOT_BASE_URL=https://chat.example.com
CHATWOOT_API_ACCESS_TOKEN=...
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_PORTAL_SLUG=withdrawl   # optional; empty = all portals for the account
OPENAI_API_KEY=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
PGVECTOR_SCHEMA=progolf_support
PGVECTOR_TABLE=progolf_faq_vectors
PGVECTOR_SYNC_DRY_RUN=false
PGVECTOR_SYNC_PRUNE_STALE=true
```

### Pinecone to PGVector migration workflow

The manual n8n workflow `ProGolf Pinecone to PGVector Migration` copies the current Pinecone namespace into `progolf_support.progolf_faq_vectors`. It uses Pinecone's REST `vectors/list` and `vectors/fetch` APIs, then upserts into Chatwoot Postgres through the `Chatwoot PGVector Postgres` credential.

Required n8n environment:

```bash
PINECONE_API_KEY=...
PINECONE_INDEX=pro-golf-support
PINECONE_NAMESPACE=progolf_faqs
PGVECTOR_SCHEMA=progolf_support
PGVECTOR_TABLE=progolf_faq_vectors
```

Optional migration controls:

```bash
PINECONE_INDEX_HOST=        # Optional; workflow resolves from PINECONE_INDEX when empty
PINECONE_MIGRATION_PREFIX=  # Optional ID prefix filter
PGVECTOR_MIGRATION_MAX_RECORDS=
PGVECTOR_MIGRATION_RECREATE=false
PGVECTOR_MIGRATION_PRUNE_STALE=false
```

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

- **`access to env vars denied` / `Cannot assign to read only property 'name'`** — Recent n8n blocks `$env` in Code nodes unless you set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on the n8n container (included in this repo’s `docker-compose.yml`). After adding it, run `docker compose down && docker compose up -d`. Ensure Chatwoot/OpenAI vars are in `.env` so they are passed into the container.
- **`Postgres idempotency failed; fail-closed handoff`** — The workflow intentionally escalates when Postgres errors. Common causes: migration not applied (`migrations/001_bot_support_state.sql`), n8n **Bot Postgres** credential missing/wrong (host must be `postgres`, not `localhost`, when n8n runs in Compose), or SQL error on the idempotency insert. In n8n, open execution data for **Load Bot State from Postgres** and **Idempotency / Debounce** and read the `error` field. `dbState: null` alone is normal for a new conversation; `postgresFailed: true` is not.
- Labels API 422 → titles must exist beforehand.  
- Empty transcript → LIST messages query returns different envelope; tweak parsing in Build Prompt Code.  
- OpenAI refuses JSON → Temperature already low; widen system prompt minimally.  
- Guided menu not rendering → confirm channel supports Chatwoot `input_select`; text fallback still works if customer sends the option value manually.
- Guided form not rendering → confirm channel supports Chatwoot `form`; web widget is the safest target.
- Flow route fails → check `Fetch Guided Flow` has valid `entry`, `nodes`, and targets that exist.

## License

MIT (project scaffold – adjust as needed).
