# Manual QA matrix

## Static guided bot (`chatwoot-support-bot`)

Run after importing `workflows/chatwoot-support-bot.json` into n8n and wiring env vars.

| Case | Payload / action | Expected |
|------|------------------|----------|
| First entry guided menu | Send `hi`, `hello`, `help`, or an empty first customer message | Public `input_select` menu from `Fetch Guided Flow`; conversation custom attributes include `n8n_guided_flow.current_node=main` |
| Nested option | Select `Withdrawal`, then `How long does withdrawal take?` | Public deterministic text plus resolution `input_select`; state path includes `withdrawal` and `withdrawal_timing` |
| Form option | Select `Lost Reward` | Public Chatwoot `form` asking `Where did you lose it?`; state current node is `lost_reward_form` |
| Form submit | Submit `lost_location` in the `Lost Reward` form | Existing handoff path with private note containing `form_data.lost_reward_form.lost_location` |
| Resolved option | Select `Yes, resolved` after a guided answer | Public closing message; state current node is `resolved`, no LLM call |
| Unresolved option | Select `No, talk to a human` after a guided answer | Existing handoff path with `guided_flow` / `human_requested` labels and private note |
| Custom question prompt | Select `Ask a custom question` | Conversation enters `llm` node and next free-text message routes to AI Agent |
| Custom LLM loop | After custom prompt, send a free-text issue | Message routes through AI Agent, Safety Gate, Failed Turn Tracker, and stores updated `llm_turns` |
| Text fallback | Send `withdrawal`, `lost reward`, `custom`, `human`, or current option ID instead of clicking UI | Router treats text as matching current dynamic option |
| Loop prevention | Simulate `message_created` with `sender.type != contact` OR `message_type` outgoing OR `private: true` | Webhook `{ ok:true, ignored:not_customer_incoming }`, no Chatwoot API calls beyond prior nodes |
| Human handoff phrase | Ask model (or fixture) returning `needs_human: true` or `risk_flags` includes `human_requested` | Labels + private note + `status:open`, no public reply |
| Unknown / low confidence | Prompt that yields `<0.75` confidence | Handoff path |
| LLM outage | Break `OPENAI_API_KEY` temporarily during custom mode | Handoff with `[n8n bot v2]` private note referencing `tool_failed` and guided state |
| Duplicate delivery | Replay same Chatwoot `message.id` twice within `IDEMPOTENCY_WINDOW_MS` | Second `{ ok:true, ignored:duplicate_message }` |
| Burst typing | Two different message ids inside `CONVERSATION_DEBOUNCE_MS` | Second may `{ ignored:conversation_debounce }` |

Tip: activate workflow, use Chatwoot test inbox, watch n8n Executions + Chatwoot conversation.

## RAG guided bot (`chatwoot-rag-guided-bot`)

Prerequisites: Pinecone index populated (`npm run rag:upsert` from repo root; see README), `PINECONE_INDEX` set, OpenAI + Pinecone credentials on workflow nodes, Agent Bot URL → `/webhook/chatwoot-rag-guided-bot`.

| Case | Payload / action | Expected |
|------|------------------|----------|
| In-scope lost reward | Send `I lost my reward` with chunks about `lost_reward` above `RAG_MIN_SCORE` | Public `input_select` with prompt like “Where did you lose the reward?”; options from chunk `game_contexts`; tips in message body; `n8n_guided_flow.mode=rag_guided` |
| Option follow-up | Click `Tournament` (or send `tournament` as text) | Next planner step using updated `path` / `slots`; retrieval query includes prior context |
| Out of knowledge | Ask something unrelated (e.g. corporate HR policy) with no matching chunks | Handoff: labels `bot_escalated`, private note with `out_of_knowledge` / low score, no public bot reply |
| Planner out of scope | (Fixture) planner returns `in_scope: false` | Same handoff path |
| Human phrase | `talk to a human` | Handoff via guardrail `human_requested` |
| Duplicate delivery | Replay same `message.id` within window | `{ ok:true, ignored:duplicate_message }` |
| Parse failure | Break Flow Planner JSON (e.g. invalid API response) | Handoff with `tool_failed` in private note |

Tune `RAG_MIN_SCORE` after inspecting Pinecone similarity scores in n8n execution output for your index.
