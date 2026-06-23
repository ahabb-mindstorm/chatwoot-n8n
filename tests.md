# ProGolf Support Bot Scenario Tests

Status: Active regression guide.

Primary PGVector workflow: `GcKbOSy3k8hqfqIr` (`ProGolf Support Bot (v2) Postgres Memory PGVector RAG`)

Pinecone comparison workflow: `3wdQS74CW8vJcPnB` (`ProGolf Support Bot (v2) Postgres Memory`)

Use each workflow's current production webhook path from n8n. Do not assume a static path after duplication.

Purpose: run realistic player conversations, inspect n8n executions, and grade whether the bot is grounded, contextual, scoped to ProGolf, and good at escalating only when useful.

## Grading Rubric

Each scenario should be graded after inspecting the player-visible reply, relevant n8n run data, retrieval/tool calls, QA output, action/category/reward_source, and Chatwoot custom attributes.

Use these grades:

- Pass: behavior matches expected outcome and no meaningful product risk.
- Minor: mostly correct, but wording, timing, or form choice could be better.
- Fail: wrong action, invented game facts, repeated answer loop, off-topic answer, bad form, or lost context.
- Blocked: scenario could not be executed due to workflow/API/test setup issue.

Core checks:

- Grounding: factual game answers are supported by retrieved FAQ/PGVector evidence.
- No invention: no unsupported mechanics, policies, troubleshooting, reward rules, or account-specific claims.
- Retrieval use: non-greeting game/support messages call RAG when official context is needed.
- Context: vague follow-ups resolve from Postgres Chat Memory without leaking across account/conversation session keys.
- Scope: non-ProGolf questions are refused without answering the unrelated topic.
- Escalation: forms appear after useful self-checks or when human investigation is needed.
- Dynamic forms: fields already answered in chat are omitted and saved as known values.
- Attachments: form messages include attachment config; upload-only events do not trigger bot replies.
- Player UX: reply is short, plain text, no Markdown artifacts, no internal retrieval language.

## Result Template

Use this table when recording a run:

| Scenario | Conversation / Run IDs | Grade | Player-visible result | Retrieval / QA notes | State / form notes | Fix needed |
|---|---|---|---|---|---|---|
|  |  | Pass / Minor / Fail / Blocked |  |  |  |  |

## Suite 1: Greetings And Auto Greeting

Goal: greetings should be lightweight and must not create polluted support context.

### 1.1 Simple Greeting

Turns:

1. `hi`

Expected:

- Action is `reply`.
- Warmly asks what ProGolf issue the player needs help with.
- No FAQ/RAG call required.
- Memory may store the greeting, but later turns must not treat it as a support issue.

### 1.2 Auto Greeting Then Real Question

Setup:

- Client sends automatic `hi` / `auto_greeting`.

Turns:

1. `what are coins for?`

Expected:

- Bot answers the coins question, not the greeting.
- It should use RAG because this is a factual game question.
- No off-topic boundary.
- The real question must control the response even when the greeting is present in memory.

## Suite 2: Scope Boundary

Goal: the bot must never answer biology/general-world questions, but must still accept valid ProGolf topics like clubs, matchmaking, minigames, rewards, and currencies.

### 2.1 Biology Question

Turns:

1. `what is mitosis?`

Expected:

- Bot does not answer what mitosis is.
- Action is `reply`, category `other`, reward_source empty.
- Reply should be exactly or close to: `I can help with Pro Golf: Real Cash questions and support issues. What do you need help with in the game?`
- It may call RAG first because the prompt requires retrieval before boundary decisions for non-greetings.
- It must not include any biology explanation.

### 2.2 Biology Follow-up After Game Issue

Turns:

1. `I didn't get my tournament reward`
2. Bot asks a ProGolf clarification or gives supported self-check.
3. `what is mitosis?`

Expected:

- Old conversation memory must not force an in-scope answer.
- Bot refuses the biology question without answering it.
- Memory may preserve prior reward context, but the latest reply must enforce the scope boundary.

### 2.3 Valid ProGolf Topics Are Not Blocked

Run each as a fresh single-turn question:

- `how does matchmaking work?`
- `what are clubs for?`
- `what are minigames?`
- `what are coins for?`

Expected:

- Bot treats these as in-scope or ambiguous ProGolf questions.
- It should call RAG and answer only supported facts.
- It should not say these are outside ProGolf.

## Suite 3: Grounding And Hallucination Traps

Goal: QA should catch unsupported claims and rewrite conservatively.

### 3.1 Shot Distance With Clubs

Turns:

1. `how to increase shot distance on my club?`

Expected:

- No claim that upgrading clubs increases distance.
- No claim that higher-level clubs improve power, spin, control, precision, or shot distance unless directly retrieved.
- Acceptable answer: official FAQ does not support club upgrades changing shot distance; equipment facts are limited to supported cosmetic/earnings/rating effects.
- If asking clarification, it should be one focused ProGolf question.

Fail examples:

- `Upgrade your clubs to increase shot distance.`
- `Higher-level clubs have better performance.`
- `Aim for perfect shots to maximize distance` unless directly retrieved for this exact topic.

### 3.2 Club Upgrades And Spin

Turns:

1. `can i add more spin with club upgrades?`

Expected:

- No unsupported spin/control/performance claim.
- Should answer conservatively from FAQ-supported equipment facts.

### 3.3 Submitting Clubs To Enter

Turns:

1. `where do i submit the clubs to enter?`

Expected:

- No invented inventory-check or auto-submit flow.
- Should say FAQ only supports that some tournaments may require an equipment item, if that evidence is retrieved.
- Should ask what the tournament screen shows or whether it is asking for a required item.

Fail examples:

- `The game automatically checks your inventory.`
- `You don't need to submit them separately` unless directly supported.

### 3.4 Tournament Entry With Equipment

Turns:

1. `how can i play a tournament?`

Expected:

- Answer should include only supported tournament entry facts.
- If retrieval says entry fee can be coins/cash/rewarded videos/equipment, verify exact wording before allowing it.
- No weird unsupported phrasing like `pay the entry fee using equipment` unless FAQ explicitly says that.

## Suite 4: Reward Clarification And Self-Help Before Escalation

Goal: vague reward/money reports should retrieve possible meanings, clarify source, then provide supported checks before form handoff.

### 4.1 Vague Reward

Turns:

1. `reward`

Expected:

- Bot should not guess the source immediately.
- Should ask one focused clarification about reward source, using ProGolf examples if supported: tournament, daily bonus, Golf Pass, loot bag, TopShot, minigame, balance reward.
- No form yet.

### 4.2 Lost Money

Turns:

1. `i lost my money`

Expected:

- Bot should clarify whether this is purchase/payment, tournament winnings, withdrawal, Bonus Cash/cash balance, or another in-game currency issue.
- No invented refund/compensation promise.
- No generic form unless the player asks for human support or gives a clearly investigable issue.

### 4.3 Tournament Reward Self-Check

Turns:

1. `I didn't get my tournament cash`
2. If asked source/type, answer: `tournament reward`
3. If asked tournament, answer: `the $4 tournament`

Expected:

- Category should be `reward`, reward_source `tournament`.
- Bot should not classify as `withdrawal`.
- Bot should provide supported tournament reward checks before form handoff, such as checking finalized results/prizes/Bonus Cash split only if retrieved.
- It should not jump straight to a generic withdrawal or reward form after only the tournament name/amount.

### 4.4 Tournament Reward Amount Follow-up

Turns:

1. `I am missing my tournament reward`
2. Bot asks what the Prizes tab shows or expected amount.
3. `I should get $1`

Expected:

- Bot treats `$1` as the expected reward/answer to the prior question.
- It must not repeat the same prize-pool checklist verbatim.
- Next step should ask at most one relevant missing distinction or escalate if the supported self-check has already been exhausted.
- `collected_fields.expected_reward` should contain `$1` or equivalent when escalation occurs.

### 4.5 Repeated Amount Means Still Missing

Turns:

1. `I am missing my tournament reward`
2. Bot asks self-check / expected amount.
3. `$1`
4. Bot asks whether it appears in Cash or Bonus Cash.
5. `still didn't get it`

Expected:

- Bot resolves `it` to the tournament cash reward from Postgres memory.
- Should not reset to generic missing reward.
- Should escalate with tournament reward form or direct handoff depending on collected fields.

## Suite 5: Daily Bonus And Golf Pass Context

Goal: short follow-ups should preserve reward source through Postgres Chat Memory.

### 5.1 Daily Reward Follow-up

Turns:

1. `daily reward`
2. Bot explains/asks relevant daily reward question.
3. `i didn't get it`

Expected:

- Bot resolves `it` as daily reward/daily bonus.
- The agent should preserve `daily_bonus` context in its output and retrieval query.
- It should not switch to generic reward or tournament reward.

### 5.2 Golf Pass Loot Bag

Turns:

1. `I missed my 3rd tier lootbag reward`
2. If asked source, answer: `golf pass`

Expected:

- Bot keeps source aligned with Golf Pass or loot bag, depending on FAQ evidence and player's wording.
- It must not invent level completion requirements unless retrieved.
- If retrieval does not mention level completion, it should not tell the player to check completed levels.

### 5.3 Club Bonus Follow-up

Turns:

1. `I didn't get my club bonus`
2. Bot asks clarification or explains supported club/equipment bonus facts.
3. `still didn't get the bonus from it`

Expected:

- Bot resolves `it` to the club/equipment bonus context.
- It should not reset to generic reward or ask source again.
- If human investigation is needed, form/source should match the club/equipment bonus issue as closely as available.

## Suite 6: Dynamic Forms And Known Values

Goal: when the player already gave useful details in chat, the form should omit those fields and save them for agents.

### 6.1 Tournament Reward Known Values

Turns:

1. `I missed my tournament reward yesterday, tournament 123, expected $1`

Expected:

- If escalating, collected_fields should include:
  - `tournament_id`: `123`
  - `when`: `yesterday`
  - `expected_reward`: `$1`
  - `details`: concise missing tournament reward summary
- Form should omit the three structured values already supplied.
- It must not ask the player to restate the known problem as though `details` were missing. Either omit `details` and offer a separate optional `additional_context` field, or prefill the known description if the form renderer supports editable defaults.
- Known values should appear in the private note under known-from-chat style section.

### 6.2 Purchase Known Values

Turns:

1. `Apple Pay $9.99 yesterday didn't show up`

Expected:

- Category `purchase_payment`.
- collected_fields should include `payment_method`, `amount`, `payment_date`, and `details`.
- Form should still ask for missing required info like `email`.
- No invented email/device/order id.

### 6.3 All Required Fields Given

Turns:

1. `My PayPal withdrawal reference WD123 for $10 requested yesterday still hasn't arrived. My PayPal email is test@example.com.`

Expected:

- Category `withdrawal`.
- If all required withdrawal fields are collected, skip form and hand off directly.
- Private note includes known values.
- Player gets ticket ID in handoff message.

## Suite 7: Attachments In Form Handoff

Goal: attachment UI appears on forms and upload-only events do not trigger LLM replies.

### 7.1 Form Includes Attachment Config

Trigger representative form shapes:

- purchase/payment
- technical bug
- reward/tournament

Use a static requirements-workflow inspection for the remaining categories; repeating the same UI assertion for every category adds little signal unless their attachment configuration differs.

Expected:

- Form message includes `attachment_config.enabled = true`.
- Accepts `image/*` and `video/*`.
- `max_files = 3`.
- Attachments optional.
- Prompt is category appropriate where possible.

### 7.2 Upload-only Event

Turns:

1. Open an escalation form.
2. Upload image/video before submitting form.

Expected:

- Upload-only `message_created` with no text is ignored.
- Bot does not call LLM.
- Bot does not send a reply while the player is attaching files.

### 7.3 Submitted Form With Attachments

Turns:

1. Open an escalation form.
2. Upload one image.
3. Submit form.

Expected:

- n8n reads attachment refs from `attachment_refs`, `attachmentRefs`, `_attachment_refs`, submitted `_attachment_refs`, or Chatwoot raw attachments.
- Private note includes attachment count and metadata: filename if available, type/content type, size, message id / attachment id.
- `_attachment_refs` is not shown as a normal form field.
- Agent can see files in Chatwoot timeline.

## Suite 8: Plain Text Formatting

Goal: player replies should render cleanly in the chat bubble.

### 8.1 Tournament Reward Checklist Formatting

Turns:

1. `I am missing a tournament reward`

Expected:

- No Markdown syntax such as `**Prize Pool**`.
- No inline numbered blob like `1. ... 2. ... 3. ...`.
- If multiple checks are given, each check is separated by line breaks.

Good shape:

```text
Here are a few things to check:

Prize pool: Open the tournament Prizes tab and compare the reward for your placement.

Results: If results are pending, final rank and winnings may not be available yet.

What does the Prizes tab show for your placement?
```

## Suite 9: No Internal Retrieval Language

Goal: do not expose implementation details to players.

### 9.1 Weak Retrieval But In-Scope

Turns:

1. Ask a niche but plausible ProGolf question not well-covered by FAQs.

Expected:

- Bot must not say `I could not find anything in retrieval`, `FAQ search`, `knowledge base`, or similar.
- It should answer only supported parts, ask one clarification, or escalate.

## Suite 10: PGVector Versus Pinecone Comparison

Goal: detect whether PGVector staging regressed retrieval quality versus the Pinecone production workflow.

Run a representative subset of existing scenarios against both workflows rather than maintaining a second independent scenario list:

- Suite 2.3: coins and matchmaking
- Suite 3.1: shot-distance hallucination trap
- Suite 4.3: tournament reward
- Suite 5.2: Golf Pass loot bag
- Suite 13.1: cheating report

Expected:

- Staging should retrieve equivalent or better FAQ evidence.
- PGVector should not have weaker follow-up memory; both workflows use equivalent Postgres chat-memory configuration.
- Any answer differences should be explainable by retrieved FAQ chunks and QA status.

Record for each:

- Workflow id
- Execution id
- Search query/query topics
- Retrieved FAQ ids
- QA status
- Final player reply
- Grade

## Suite 11: Postgres Chat Memory Persistence

Goal: confirm persistent transcript memory works across executions and remains isolated by account and conversation.

### 11.1 History Created

Turns:

1. `daily reward`

Expected execution/memory behavior:

- Session key is `progolf_support_json_v2:<accountId>:<conversationId>` (or the intentionally configured workflow-specific prefix).
- The first turn loads empty history and saves the user/assistant exchange.
- A later execution for the same session loads that exchange.
- Memory-node load/save operations succeed without invoking the error branch.

### 11.2 History Used For Short Follow-up

Turns:

1. `daily reward`
2. `i didn't get it`

Expected:

- Second turn loads the first turn from Postgres memory.
- RAG search query should be topic-oriented, not just `i didn't get it`.
- Bot does not ask from scratch what reward this is.

### 11.3 History Does Not Pollute New Topic

Turns:

1. `daily reward`
2. `what are clubs for?`

Expected:

- Bot changes topic to clubs/equipment.
- Old daily reward history does not force a reward answer.

### 11.4 Session Isolation

Setup:

- Use two different Chatwoot conversations, and preferably two account IDs when available.

Expected:

- Each execution loads only its own session history.
- No player message, tool result, or assistant answer from the other session appears in memory.

## Suite 12: Handoff Quality

Goal: when handoff happens, player and agent both get useful, clean information.

### 12.1 Ticket ID In Player Message

Turns:

1. Trigger a direct handoff or complete an escalation form.

Expected:

- Player message includes `Ticket ID: #<conversationId>`.
- It does not duplicate ticket ID if already present.

### 12.2 Private Note Has Useful Sections

Turns:

1. Submit a form with some known values and one attachment.

Expected private note:

- Category
- Reward source when relevant
- Summary
- Known from chat
- Submitted form values
- Attachments section
- No `_attachment_refs` as a normal field

## Suite 13: Actionable Player Reports

Goal: reports of cheating, unfair play, harassment, or another player should be treated as actionable reports—not FAQ questions or requests to find another support channel.

### 13.1 Cheating Report In A Tournament

Regression example: workflow execution `11778`, conversation `595`.

Turns:

1. `in FELIX_CUP_413413515, there is a cheater`

Expected:

- Search may run once, but adjacent articles about tournament cancellation or review must not be presented as a resolution.
- The bot recognizes this as an actionable cheating/unfair-play report on the first turn.
- It does not tell the player to use an "appropriate in-game channel" or contact support elsewhere; this chat is already support.
- Route to human intake using `player_report`.
- Preserve `FELIX_CUP_413413515` as the tournament identifier and preserve the cheating allegation as known issue context when those canonical fields are available.
- Do not state or imply that the named player cheated as an established fact; describe it as the player's report.

Regression transcript to reject:

```text
Bot: Check the leaderboard for tournament cancellation or review updates and report it through the appropriate in-game channels.
```

Follow-up guard:

1. `i am reporting it through the appropriate channel. what other appropriate channel is there?`
2. `i AM DOING THAT RIGHT NOW`

Expected:

- Bot acknowledges that the player is already reporting through support and proceeds with intake/handoff.
- It does not close the conversation, redirect again, or ask whether the player needs anything else.

## Regression Watchlist

These are specific bad behaviors seen before. Any recurrence is a fail unless retrieval now explicitly supports it.

- Answering biology/general questions after saying they are outside scope.
- Saying clubs/upgrades increase shot distance, spin, power, precision, or performance without exact FAQ support.
- Saying tournament entry automatically checks club inventory without FAQ support.
- Treating `didn't get tournament cash` as a withdrawal.
- Opening a generic reward form after the player has clarified a tournament/daily/Golf Pass reward source.
- Repeating the exact same FAQ checklist after the player answers the bot's question.
- Showing Markdown artifacts like `**Prize Pool**` in plain chat.
- Mentioning retrieval, FAQ search, or lack of search results to the player.
- Losing context for `it`, `them`, `still didn't get it`, `$1`, or `daily reward`.
- Saving full transcript, raw FAQ chunks, or tool outputs into Chatwoot custom attributes.
- Treating a cheating/player report as a normal FAQ or redirecting the player to another support channel.
