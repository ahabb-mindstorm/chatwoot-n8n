# ProGolf Support Bot — P0 Production Checklist

Workflow: `T0VBNptQWDr7lT16`  
Dependent workflow: `YD4d0AAkcvOSSLua`

Do not send production traffic to the workflow until every item below is complete and verified in staging.

## 1. Secure the Chatwoot webhook

- [ ] Put n8n behind an HTTPS domain and reverse proxy/load balancer.
- [ ] Remove public access to the raw n8n port (`5678`).
- [ ] Enable the Webhook node's raw-body option.
- [ ] Verify `X-Chatwoot-Signature` using HMAC-SHA256 over `"{timestamp}.{raw_body}"`.
- [ ] Compare signatures using a constant-time comparison.
- [ ] Reject missing or invalid `X-Chatwoot-Signature` and `X-Chatwoot-Timestamp` headers.
- [ ] Reject webhook timestamps older than five minutes.
- [ ] Validate the expected Chatwoot account ID and inbox ID before any AI or API action.
- [ ] Restrict ingress to Chatwoot IPs where operationally possible.
- [ ] Store the Chatwoot webhook secret in n8n credentials or a secrets manager, not workflow code.
- [ ] Test valid, invalid, expired, tampered, and replayed webhook requests.

## 2. Add durable idempotency and conversation locking

- [ ] Create a Postgres table for processed webhook deliveries/messages.
- [ ] Add a unique constraint using account ID plus `X-Chatwoot-Delivery`; fall back to account ID plus message ID when delivery ID is unavailable.
- [ ] Record the delivery before producing Chatwoot side effects.
- [ ] Treat duplicate deliveries as successful no-ops.
- [ ] Add a per-conversation Postgres advisory lock or equivalent serialization mechanism.
- [ ] Key conversation locks by both Chatwoot account ID and conversation ID.
- [ ] Prevent concurrent turns from reordering replies or overwriting escalation attributes.
- [ ] Track each outbound side effect so retries cannot duplicate public messages, forms, private notes, labels, or handoffs.
- [ ] Define cleanup/retention for idempotency records.
- [ ] Test duplicate delivery, rapid consecutive messages, and workflow retry scenarios.

## 3. Use Postgres-backed memory for the AI Agent

- [ ] Remove the current `Conversation Memory` Simple Memory node.
- [ ] Add an n8n Postgres Chat Memory node and connect it to the AI Agent's memory input.
- [ ] Create a dedicated least-privilege Postgres credential for AI memory.
- [ ] Use a production session key containing at least account ID and conversation ID, for example: `progolf_support:v2:<accountId>:<conversationId>`.
- [ ] Do not use conversation ID alone as the session key.
- [ ] Store only the minimum conversation content needed by the agent.
- [ ] Set a bounded context window and maximum token budget.
- [ ] Define a memory TTL/retention policy.
- [ ] Delete or expire memory when a conversation is resolved.
- [ ] Reset memory when the same conversation starts a genuinely new support case.
- [ ] Prevent old escalation fields and summaries from contaminating later cases.
- [ ] Ensure form-submitted payment, phone, email, and attachment details are not unnecessarily sent back to the AI model.
- [ ] Confirm memory works across n8n restarts and multiple workers.
- [ ] Test account isolation using identical conversation IDs in two different Chatwoot accounts.

## 4. Add a deterministic safety and grounding gate

- [ ] Replace `Merge QA With Routing Decision`; it currently performs no independent QA.
- [ ] Remove or replace the disconnected `Normalize Agent Output` node; do not reconnect its current hardcoded factual responses.
- [ ] Require every structured output field: `action`, `reply`, `category`, `summary`, `reward_source`, `collected_fields`, and `handoff_override_reason`.
- [ ] Force an immediate handoff when the player explicitly asks for a human.
- [ ] Force handoff for critical, security, legal, account-deletion, billing-dispute, or other defined high-risk cases.
- [ ] Fail closed to human handoff when the model, parser, Pinecone, embeddings, or escalation-requirements workflow fails.
- [ ] Require factual replies to reference FAQ/document IDs retrieved during the same turn.
- [ ] Add a minimum retrieval relevance threshold.
- [ ] Block factual replies when retrieval is empty, weak, irrelevant, or does not directly support the answer.
- [ ] Prevent the model from adding unsupported timing, payout, gameplay, or policy claims.
- [ ] Enforce reply length and plain-text formatting limits after model generation.
- [ ] Log the final action, retrieved FAQ IDs, retrieval scores, safety decision, and handoff reason without logging unnecessary PII.
- [ ] Test the known failure cases: explicit human request and missing tournament reward payout timing.

## 5. Make human handoff reliable

- [ ] Configure a real Chatwoot escalation team and/or assignee.
- [ ] Pre-create and verify every category label used by the workflow (`purchase_payment`, `withdrawal`, `account`, `technical_bug`, `gameplay_tournament`, `ban_appeal`, `player_report`, `reward`, `other`).
- [ ] Add a dedicated `bot_escalated` label.
- [ ] Ensure opening and assigning the conversation cannot be blocked by a non-critical label failure.
- [ ] Define the handoff operation order and required success conditions.
- [ ] Add bounded exponential-backoff retries for Chatwoot 429 and 5xx responses.
- [ ] Do not retry non-transient 4xx errors blindly.
- [ ] Make outbound message creation idempotent before enabling retries.
- [ ] Add explicit HTTP timeouts to every Chatwoot request.
- [ ] Create and attach an n8n Error Workflow that alerts the support/engineering on-call channel.
- [ ] Include workflow ID, execution ID, conversation ID, failed node, and error class in alerts without exposing sensitive form values.
- [ ] Add a recoverable failed-handoff/dead-letter state in Postgres.
- [ ] Verify that a failed handoff is visible to humans and can be replayed safely.
- [ ] Test failures independently at internal-note, label, assignment, player-notification, and conversation-open steps.

## Final P0 launch gate

- [ ] All P0 tests pass in a staging workflow with separate Chatwoot, OpenAI, Pinecone, and Postgres credentials.
- [ ] No production credentials or player data are used in automated tests.
- [ ] A reviewed workflow export and rollback version are stored in source control.
- [ ] The staging workflow passes an end-to-end Chatwoot conversation, FAQ reply, form submission, and human handoff test.
- [ ] Invalid or replayed webhook requests produce no Chatwoot side effects.
- [ ] Duplicate deliveries produce exactly one player-facing response.
- [ ] Explicit human requests always reach an assigned human queue.
- [ ] Unsupported factual answers are blocked or handed off.
- [ ] Postgres memory survives restart, remains account-isolated, and clears on resolution.
- [ ] Error alerts and safe replay are verified.
- [ ] Production rollout begins as a limited canary with a documented kill switch.
