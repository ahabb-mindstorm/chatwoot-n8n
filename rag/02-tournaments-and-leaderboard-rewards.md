---
topic: tournaments
keywords: tournament, leaderboard, rank reward, prize, forfeit, history, claim tournament, cancelled, reimbursement, completion reward
---

# Tournament rewards (career, challenges, seasonal)

Tournaments are a primary source of rank prizes, completion loot bags, and **Best Shot** prizes. Rewards are **not always instant** — many require the tournament to **finish** and the player to **claim** from history.

## Reward categories

### 1. Rank / leaderboard prizes (tournament winning)

When a tournament ends, the server calculates prizes by **final rank** on the leaderboard.

- Prizes come from configured **rank reward** tiers (1st, 2nd, etc.)
- Tied scores may **split** combined prizes between tied players
- Player must **claim** from **tournament history** (single claim or claim all)
- Claim applies currency/equipment and may create **pending loot bags** on home

**If never claimed:** Prize remains on the history heading as unclaimed until the player claims it (not the same as server deleting it).

### 2. Tournament completion rewards (milestone / streak)

Separate from rank: completing tournaments in a category can unlock **completion loot bags** based on rules (par score, number of completions in a row, etc.).

- Loot bags are opened into **pending loot bags** when rules pass
- Other completion currencies/XP may go to **pending rewards** on home

### 3. Best Shot (see dedicated doc)

Often shown on the same tournament result card as rank rewards.

## Forfeit = no rank prize

A player is **forfeited** when they do not complete all holes before the tournament ends (or are marked forfeited when time runs out with incomplete holes).

**Forfeited players do not receive rank leaderboard prizes.** They may still receive an **empty** reward record for stats, but not cash/prizes from placement.

**Player language:** "I didn't finish all holes" / "ran out of time" → explain forfeit rules.

## Empty rank tier

If the player's final rank is **below** the configured prize tiers, they get **no rank reward** (not a bug). They may still claim an **empty reward** flow for UI closure in some cases.

## Claiming tournament rewards

1. Go to **tournament history** or post-tournament results
2. Tap **claim** on the event (or **claim all** for multiple unclaimed events)
3. Server marks reward as claimed and removes it from "claimable" lookup
4. Open any **loot bags** on home afterward

**Claim all** has a server time limit per batch; if many tournaments are unclaimed, player may need to run claim all again.

## Tournament cancelled

If a tournament is **cancelled** by the system:

- **Entry fees** may be refunded (cash/bonus cash) via a **reimbursement** pending reward
- **Unclaimed** tournament completion / winning pending entries for that tournament ID are **removed** from pending rewards
- If the player **already claimed** rank cash, cancellation may **deduct** that cash from the wallet (payment history type: tournament cancellation)

**Support:** Check payment history for reimbursement vs deduction.

## Seasonal / season event tournaments

Season calendar tournaments use similar rank logic but **season event** reward types. Incomplete season event rounds are treated like not completed for prize calculation.

Unclaimed season history prizes may be posted to **news/inbox** as a message to claim later.

## Challenges (friend tournaments)

Player-created **challenges** use challenge lobbies. Rank rewards use challenge-specific flows; expired or rejected challenges return **entry fees** (sometimes with a cancel fee deduction). See `10-challenges.md`.

## Season Pass tournament (within pass)

Season pass includes its own tournament leg; states include **ForfeitedTournament** and **Expired** on the pass instance — unclaimed pass track rewards may be blocked. See `08-season-pass.md`.

## "Lost" tournament reward checklist

1. Did the player **finish all holes** (not forfeited)?
2. Was their **rank** within a paying tier?
3. Did they **claim** in tournament history?
4. For loot bags — did they **open pending loot bags** on home?
5. Was the tournament **cancelled** after they claimed cash?
6. Are they looking at **completion** vs **rank** reward (different rules)?
