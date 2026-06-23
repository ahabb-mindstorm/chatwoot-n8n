# ProGolf Support Bot — Browser Test Findings

> Historical snapshot: these findings describe the workflow state tested on 2026-06-22. The workflow, routing, memory, and test guide have changed since this run; re-run affected scenarios before treating a prior pass as current.

**Date:** 2026-06-22  
**Workflow:** `GcKbOSy3k8hqfqIr` — *ProGolf Support Bot (v2) Postgres Memory PGVector RAG*  
**Environment:** [support.progolf.cash](https://support.progolf.cash/?player_id=ahabb124&player_name=ahabb123&support_landing_source=main_menu&last_3_tournament_ids=123,456,789)  
**Test guide:** `tests.md`  
**Method:** Fresh chat per scenario via rotated `player_id`; ~15–35s wait for RAG replies  
**n8n:** 160+ executions during the run — all `success`, no workflow errors

---

## Executive Summary

| Grade | Count |
|-------|------:|
| **Pass** | 9 |
| **Minor** | 5 |
| **Fail** | 1 |
| **Blocked** | 0 |

The bot is **production-usable** for most support flows: scope boundaries work, FAQ answers are generally grounded, reward issues get clarification before escalation, and follow-up context (`it`, `$1`, daily reward) is preserved well.

The main regression is **equipment hallucination** — the shot-distance trap (Suite 3.1) still recommends club upgrades for performance. Dynamic forms partially omit known fields but don't fully pre-fill chat-given values.

**Overall verdict: B+ — good for staging/production with one critical fix needed.**

---

## Scenario Results

| Scenario | player_id | Grade | Player-visible result | Notes |
|---|---|---|---|---|
| **1.1** Simple greeting | test6201 | **Minor** | "Hello again! If you have any questions…" | Warm and on-scope, but redundant after auto-greeting |
| **1.2 / 2.3** Coins FAQ | test6202 | **Pass** | Explained coins → Converter tournament → Bonus Cash, daily free coins | Grounded, plain text, no markdown |
| **2.1** Biology boundary | test6203 | **Pass** | "I'm here to help with Pro Golf: Real Cash…" | Did not explain mitosis |
| **2.2** Biology after game issue | test6208 | **Pass** | Reward clarification → scope refusal on mitosis | Prior reward context did not force in-scope biology answer |
| **2.3** Matchmaking | test6213 | **Pass** | Skill-based pairing, improves over time, not manually adjustable | In-scope, factual |
| **3.1** Shot distance trap | test6204 | **Fail** | Suggested perfect shots, tee-off bonus, **and upgrading clubs for performance** | Violates regression watchlist — unsupported club-upgrade → distance claim |
| **3.2** Club spin | test6209 | **Minor** | Correctly denied spin from upgrades, but added "better overall performance" | Mostly conservative; still a soft performance claim |
| **4.1** Vague `reward` | test6205 | **Pass** | Asked tournament vs daily bonus vs other; no form | Correct clarification flow |
| **4.2** Lost money | test6213 | **Pass** | Asked purchase/tournament/withdrawal; no refund promise | Good disambiguation |
| **4.3** Tournament cash | test6206 | **Pass** | Asked which tournament, when, check balance | Not misrouted to withdrawal |
| **4.4** `$1` follow-up | test6210 | **Minor** | After "$1", jumped straight to escalation form | Skipped Cash vs Bonus Cash question; didn't repeat checklist verbatim |
| **5.1** Daily reward → `i didn't get it` | test6207 | **Pass** / Minor formatting | Resolved "it" as daily reward; gave login-streak checks | Used inline `1. 2. 3.` numbering (Suite 8 concern) |
| **6.1 / 4.5** Known values + escalation | test6212 | **Minor** | Used tournament 123 and $1 in reply; form omitted tournament ID but still asked WHEN and REWARD | Partial dynamic-form behavior |
| **8.1** Plain text formatting | test6211 | **Pass** | No `**markdown**` or numbered blobs on tournament reward reply | Clean player UX |

---

## Detailed Transcripts

### 1.1 Simple Greeting (test6201) — Minor

```
[Auto] SAUD: Hello! How can I assist you today with Pro Golf: Real Cash?
User: hi
Bot:  Hello again! If you have any questions or need assistance with Pro Golf: Real Cash, feel free to ask!
```

**Expected:** Warm ask about what ProGolf issue player needs help with.  
**Actual:** Repeated generic greeting after auto-greeting.

---

### 1.2 / 2.3 Coins FAQ (test6202) — Pass

```
[Auto] SAUD: Hello! How can I assist you today in Pro Golf: Real Cash?
User: what are coins for?
Bot:  Coins in Pro Golf: Real Cash can be used to participate in tournaments, specifically
      the Converter tournament, where you can compete to win Bonus Cash. This Bonus Cash
      can then be used to enter more challenging tournaments. Additionally, you can earn
      free Coins daily and use them to win cash prizes, although the Bonus Cash itself
      cannot be withdrawn.
```

---

### 2.1 Biology Boundary (test6203) — Pass

```
User: what is mitosis?
Bot:  I'm here to help with Pro Golf: Real Cash. If you have any questions about the game, feel free to ask!
```

---

### 2.2 Biology After Game Issue (test6208) — Pass

```
User: I didn't get my tournament reward
Bot:  I can help with that! Can you confirm if the tournament has fully ended? Sometimes,
      payouts can take a few minutes to process after the tournament concludes. Also,
      where do you expect to see your reward — in your balance or another location?

User: what is mitosis?
Bot:  I'm here to help with Pro Golf: Real Cash. If you have any questions or issues
      related to the game, feel free to ask!
```

---

### 3.1 Shot Distance Trap (test6204) — Fail

```
User: how to increase shot distance on my club?
Bot:  To increase shot distance with your club, consider the following tips:

      - Aim for a Perfect shot by aligning your shot perfectly in the middle of the aim
        target, which gives you a 10 point bonus.
      - Utilize the Tee off bonus when taking a tee shot; the further you hit the ball,
        the more points you earn (ranging from 0 to 100).
      - Upgrade your clubs, as some upgraded clubs unlock special features that may
        enhance your performance.

      Have you tried focusing on these aspects during your gameplay?
```

**Fail reason:** Claims club upgrades enhance performance/distance without FAQ support. Matches regression watchlist item.

---

### 3.2 Club Spin (test6209) — Minor

```
User: can i add more spin with club upgrades?
Bot:  Upgrading clubs does not specifically increase spin effects. Instead, upgraded clubs
      can unlock various features such as aim meter effects, visual aura effects, and
      pointer effects. Each club has different unlock levels, and higher-level clubs
      provide better bonuses overall. If you're looking to enhance your gameplay, consider
      upgrading your clubs for better overall performance!
```

**Minor reason:** Correctly denied spin, but still suggests "better overall performance" from upgrades.

---

### 4.1 Vague Reward (test6205) — Pass

```
User: reward
Bot:  To assist you better, could you clarify which reward you're referring to? Is it a
      tournament prize, a daily bonus, or something else? And where did you expect to see it?
```

---

### 4.2 Lost Money (test6213) — Pass

```
User: i lost my money
Bot:  I'm sorry to hear that you've lost money. Could you clarify if this loss occurred
      during a tournament, a withdrawal, or another situation? This will help me assist
      you better.
```

---

### 4.3 Tournament Cash (test6206) — Pass

```
User: I didn't get my tournament cash
Bot:  To help me understand your issue better, could you please clarify which tournament
      you participated in and when it took place? Additionally, did you check your balance
      to see if the cash has been credited there?
```

---

### 4.4 Tournament Reward Amount Follow-up (test6210) — Minor

```
User: I am missing my tournament reward
Bot:  I can help with that! To clarify, has the tournament you participated in fully
      concluded? Sometimes, rewards can take a few minutes to appear in your balance
      after the tournament ends.

User: I should get $1
Bot:  I will collect a few details so our support team can check the missing reward.
      [Form: TOURNAMENT ID, WHEN DID THE TOURNAMENT END?, REWARD YOU EXPECTED,
       WHAT HAPPENED?, Attach screenshots…, Submit]
```

**Minor reason:** Understood `$1` as expected amount but jumped to form without asking Cash vs Bonus Cash.

---

### 5.1 Daily Reward Follow-up (test6207) — Pass (Minor formatting)

```
User: daily reward
Bot:  It sounds like you're interested in the Daily Reward! You can collect your free
      Daily Bonus by logging in every day… Have you checked if you've logged in today
      to claim your reward?

User: i didn't get it
Bot:  I understand that you didn't receive your Daily Reward. Here are a few things to check:
      1. Make sure you logged in today to collect your Daily Bonus…
      2. If there was a gap in your login streak…
      3. Check if you have any notifications or messages in the game…
```

**Pass:** Resolved "it" as daily reward.  
**Minor:** Inline numbered list instead of line-break-separated checks.

---

### 6.1 / 4.5 Known Values + Escalation (test6212) — Minor

```
User: I missed my tournament reward yesterday, tournament 123, expected $1
Bot:  I understand you're missing your tournament reward from tournament 123. Rewards can
      take a few minutes to process after a tournament ends. Have you checked your balance
      to see if the $1 reward has appeared there?

User: still didn't get it
Bot:  I will collect a few details so our support team can check the missing reward.
      [Form: WHEN DID THE TOURNAMENT END?, REWARD YOU EXPECTED, WHAT HAPPENED?,
       Attach screenshots…, Submit]
```

**Minor reason:** Form omitted tournament ID (good) but still asked WHEN and REWARD YOU EXPECTED despite "yesterday" and "$1" already given in chat.

---

### 8.1 Plain Text Formatting (test6211) — Pass

```
User: I am missing a tournament reward
Bot:  Got it — you're missing a tournament reward. Can you confirm if the tournament has
      fully ended? Sometimes, payouts can take a few minutes to process after the tournament
      concludes. Also, could you let me know what type of reward you were expecting?
```

No Markdown artifacts observed.

---

## Strengths

1. **Scope boundary (Suites 2.1, 2.2)** — Off-topic biology is refused consistently, even mid-conversation after a reward report.
2. **Reward triage (Suites 4.1–4.3)** — Vague "reward" gets source clarification; tournament cash is framed as a reward issue, not withdrawal.
3. **Context memory (Suites 5.1, 4.5)** — Short follow-ups like `i didn't get it` and `still didn't get it` resolve correctly from prior turns.
4. **FAQ grounding (Suites 1.2, 2.3)** — Coins and matchmaking answers are specific, player-friendly, and in-scope.
5. **Escalation timing** — Forms appear after self-checks or explicit persistence ("still didn't get it"), not on first vague message.
6. **Workflow reliability** — All n8n executions succeeded; typical reply latency ~15–30s for RAG turns.

---

## Failures & Risks

### Suite 3.1 — Shot Distance (Fail)

Bot reply included:
> "Upgrade your clubs, as some upgraded clubs unlock special features that may **enhance your performance**."

This is exactly the regression watchlist item: claiming club upgrades improve shot distance/performance without FAQ support. QA/grounding did not rewrite it away.

### Suite 6 — Dynamic Forms (Minor)

Player said: *"tournament 123, expected $1, yesterday"*

- Form correctly **omitted** tournament ID field
- Form still asked **WHEN DID THE TOURNAMENT END?** and **REWARD YOU EXPECTED** — values already given in chat should be omitted and saved as known values

### Suite 1.1 — Greeting UX (Minor)

Auto-greeting + player `hi` → "Hello again!" — doesn't ask what specific issue they need help with.

### Suite 8 — Formatting (Minor on 5.1)

Daily reward checklist used inline `1. 2. 3.` rather than line-break-separated checks.

---

## Regression Watchlist Status

| Item | Status |
|------|--------|
| Answering biology/general questions | **Pass** — refused consistently |
| Clubs/upgrades increase shot distance/spin/performance | **Fail** — shot distance (3.1); soft claim on spin (3.2) |
| Tournament entry auto-checks club inventory | Not tested |
| `didn't get tournament cash` treated as withdrawal | **Pass** — not misclassified |
| Generic reward form after source clarified | **Pass** — tournament-specific form used |
| Repeating exact FAQ checklist after player answers | **Pass** — not observed |
| Markdown artifacts in plain chat | **Pass** — not observed in tested scenarios |
| Internal retrieval language exposed | Not tested |
| Losing context for `it`, `$1`, `daily reward` | **Pass** — context preserved |
| Full transcript/raw FAQ in Chatwoot attributes | Not tested (requires admin inspection) |

---

## Not Tested This Pass

These `tests.md` suites need separate runs (form UI, Chatwoot admin, or attachment upload):

- **Suite 7** — Attachment config / upload-only events
- **Suite 9.1** — Niche question with weak retrieval (internal language exposure)
- **Suite 10** — PGVector vs Pinecone comparison
- **Suite 11 (historical definition)** — `support_state` Chatwoot custom attributes inspection. The current guide now tests Postgres Chat Memory persistence and isolation instead.
- **Suite 12** — Handoff ticket ID and private note quality

---

## Recommendations

1. **Fix Suite 3.1 urgently** — Tighten Grounding QA prompt/rules so club-upgrade performance/distance claims are stripped. Acceptable answer: equipment upgrades don't change shot distance; only supported cosmetic/earnings/rating effects.
2. **Improve dynamic forms (Suite 6)** — When `when`, `expected_reward`, and `tournament_id` are in chat, omit those form fields and pass them as known values in the private note.
3. **Greeting copy** — After auto-greeting, respond to `hi` with something like "What can I help you with today?" instead of repeating "Hello again!"
4. **4.4 flow** — After player gives expected amount, ask Cash vs Bonus Cash before opening the form (unless they've already confirmed checking both).
5. **URL context** — `last_3_tournament_ids` from landing params is not used when player reports missing tournament cash; opportunity to pre-populate support state.

---

## Automation Notes

- Chat is inline on the page (not a Chatwoot iframe).
- Flow: `browser_navigate` with new `player_id` → click **Chat with support** → fill message → click **Send message** (or Enter).
- Allow **20–35 seconds** after send before judging no-reply failures (RAG latency).
- React-compatible input setter required for programmatic send via CDP; `browser_fill` + Send click works reliably for manual-style automation.
- Fresh chat: change `player_id` in URL and reload.
