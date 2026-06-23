# ProGolf Support Chat — Browser Test Report

**Date:** 2026-06-22  
**Environment:** [support.progolf.cash](https://support.progolf.cash/) (built-in Cursor browser)  
**Test URL pattern:** `?player_id=<id>&player_name=ahabb&support_landing_source=tournament&current_tournament_id=1234556&last_3_tournament_ids=123,456,789`  
**Method:** Each scenario used a unique `player_id` to start a fresh chat session.

---

## Executive summary

| Grade | Count |
|-------|------:|
| Pass  | 3 |
| Minor | 1 |
| Fail  | 0 |
| Blocked | 0 |

The support chat on `support.progolf.cash` is **functional and generally well-behaved**. FAQ answers are grounded, off-topic questions are refused, and tournament reward reports get appropriate clarification instead of being misrouted to withdrawal.

Main UX issues:
- Greeting responses are repetitive when the player says `hi` after the auto-greeting.
- Tournament context from URL params (`current_tournament_id`) is not used — bot still asks which tournament.
- Longer messages may require clicking **Send** (not just Enter) after `browser_fill`.

---

## How to test (built-in browser)

1. Open URL with a new `player_id`.
2. Click **Chat with support**.
3. Wait for auto-greeting from SAUD.
4. Type message → click **Send message** (or Enter for short messages).
5. Wait ~20–30s for RAG/agent replies before evaluating.

---

## Scenario results

| Scenario | player_id | Input | Grade | Bot response (summary) | Notes |
|----------|----------:|-------|-------|------------------------|-------|
| **1.1 Simple Greeting** | 9101 | `hi` | **Minor** | "Hello again! How can I assist you today in Pro Golf: Real Cash?" | Warm and on-scope, but redundant after auto-greeting. Does not ask about a specific issue. |
| **1.2 / 2.3 Coins FAQ** | 9102 | `what are coins for?` | **Pass** | Explained coins for tournament entry, Converter tournament → Bonus Cash, daily free coins, Bonus Cash not withdrawable but winnings are. | Grounded, plain text, no markdown artifacts. Good RAG answer. |
| **2.1 Biology boundary** | 9103 | `what is mitosis?` | **Pass** | "I'm here to help with Pro Golf: Real Cash. If you have any questions or issues related to the game, feel free to ask!" | Did **not** answer biology. Correct scope refusal. |
| **4.3 Tournament reward** | 9108 | `I didn't get my tournament cash` | **Pass** | Asked which tournament and whether it fully concluded; noted winnings can take a few minutes. | Correct reward/tournament framing. Not misclassified as withdrawal. Did not jump to form. |

---

## Detailed transcripts

### 1.1 Simple Greeting (player_id=9101)

```
[Auto] SAUD: Hello! How can I assist you today in Pro Golf: Real Cash?
User: hi
Bot:  Hello again! How can I assist you today in Pro Golf: Real Cash?
```

**Expected:** Warm ask about what ProGolf issue player needs help with.  
**Actual:** Repeated generic greeting. Acceptable but not ideal.

---

### 1.2 Coins FAQ (player_id=9102)

```
[Auto] SAUD: Hello! How can I assist you today in Pro Golf: Real Cash?
User: what are coins for?
Bot:  Coins in Pro Golf: Real Cash are used to enter tournaments, especially
      the Converter tournament where you can compete for Bonus Cash. Bonus Cash
      can then be used to enter more challenging tournaments. You can collect
      coins daily for free, allowing you to participate in tournaments without
      depositing real money. Remember, while Bonus Cash itself cannot be
      withdrawn, any winnings you earn from it can be. If you have any more
      questions about coins or anything else, feel free to ask!
```

**Expected:** RAG-grounded coins explanation, in-scope.  
**Actual:** Pass — specific, accurate, player-friendly.

---

### 2.1 Biology boundary (player_id=9103)

```
[Auto] SAUD: Hello! How can I assist you today in Pro Golf: Real Cash?
User: what is mitosis?
Bot:  I'm here to help with Pro Golf: Real Cash. If you have any questions or
      issues related to the game, feel free to ask!
```

**Expected:** Refuse off-topic; do not explain mitosis.  
**Actual:** Pass — no biology content.

---

### 4.3 Tournament reward (player_id=9108)

```
[Auto] SAUD: Hello! How can I assist you today in Pro Golf: Real Cash?
User: I didn't get my tournament cash
Bot:  To help with your missing tournament cash, could you clarify which
      tournament you participated in? Also, did the tournament fully conclude?
      Sometimes, it takes a few minutes for the winnings to appear in your
      balance after the tournament ends.
```

**Expected:** Tournament reward context, clarification/self-check, not withdrawal.  
**Actual:** Pass — appropriate clarifying questions and supported timing note.

**Observation:** URL included `current_tournament_id=1234556` but bot did not reference it. Opportunity to pre-fill known context from landing params.

---

## Regression watchlist (not fully tested this pass)

| Item | Status |
|------|--------|
| Vague `reward` clarification | Not run |
| Daily reward follow-up (`i didn't get it`) | Not run |
| Shot distance hallucination trap | Not run |
| Biology after game issue (multi-turn) | Not run |
| Dynamic forms / escalation | Not run |
| Markdown artifacts in replies | Not observed in tested scenarios |
| Internal retrieval language exposed | Not observed |

---

## Automation notes (built-in browser)

- Chat is **inline on the page** (not a Chatwoot iframe) — much easier than the older `csr.progolf.cash` widget.
- Workflow: `browser_navigate` → click `Chat with support` → `browser_fill` on textbox → click `Send message`.
- `browser_fill` + `Enter` works for short messages; longer text may stay in the input until Send is clicked.
- Allow **20–30 seconds** after send before judging no-reply failures (RAG latency).
- Fresh chat: change `player_id` in URL and reload.

---

## Recommendations

1. **Greeting copy:** After auto-greeting, respond to `hi` with something that acknowledges the player and asks what issue they need help with — avoid "Hello again!" verbatim repeat.
2. **URL context:** Use `current_tournament_id` and `support_landing_source=tournament` to pre-populate support state so players reporting missing tournament cash aren't asked for info already in the URL.
3. **Continue browser suite:** Run remaining scenarios from `tests.md` (vague reward, daily reward follow-up, shot-distance trap, form escalation) using the same built-in browser flow.
