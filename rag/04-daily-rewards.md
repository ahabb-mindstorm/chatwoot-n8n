---
topic: daily-rewards
keywords: daily reward, daily login, streak, timer, expired, reset, claim daily, free reward
---

# Daily rewards

Daily rewards are a **recurring login streak** on a configurable schedule (reward delay between claims and expiry if the player waits too long).

## How it works

1. Player has a **current slot** in the daily reward track (index cycles through configured rewards)
2. After claiming, a **cooldown** (`RewardDelay`) must pass before the next claim is available
3. Each reward can include currencies, equipment, loot bags, etc. — claimed immediately via the daily reward flow (loot bags go to **pending loot bags**)

## Claiming

Use the **Daily Reward** UI on home (or dedicated daily panel). Server validates:

- Cooldown elapsed since last claim
- Valid reward index

If not ready: error **no reward claimed** — player must wait for the timer.

## Streak reset (looks like "lost" reward)

If the player had a **claimable** reward but did not claim within **`RewardExpiryDelay`** after it became available, the streak **resets**:

- `CurrentClaimable` resets
- Player may lose progress on the multi-day track

**Support language:** "You needed to claim before the expiry timer on the daily reward; the streak reset."

Exact timers are **live-ops config**, not fixed in code documentation.

## After claim

Response includes updated wallet, career progress, **pending rewards**, and **pending loot bags** if the day’s reward contained bags.

## Not the same as

- **Inbox / news** rewards
- **Season pass** daily or track rewards
- Generic **pending rewards** pile on home (unless daily added bag bonus there)

## Troubleshooting

| Player report | Check |
|---------------|--------|
| Can't claim today | Cooldown not finished; show next claim time |
| Streak went back to day 1 | Expiry delay passed without claim |
| Got coins, no clubs | Open loot bags on home |
| Daily button missing | Maintenance, force update, or feature locked by level |
