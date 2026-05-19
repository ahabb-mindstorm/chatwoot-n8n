---
topic: season-pass
keywords: season pass, premium pass, track rewards, tokens, claim season pass, expired, forfeited tournament
---

# Season Pass rewards

The **Season Pass** is a seasonal progression track with free and **premium** tiers, token collection, an optional **season pass tournament**, and loot bag prizes.

## Reward types

- **Track rewards** — claimed per tier on the season pass screen (individual or claim all)
- **Equipment tokens** — season pass token currency from equipment bonuses
- **Season pass tournament** — rank prizes similar to other tournaments when the pass tournament completes
- **Pending season pass rewards** — if the season ends with unclaimed tiers, rewards may be stored as **season pass pending** for a later claim flow

## Claiming track rewards

1. Open **Season Pass**
2. Collect tokens from gameplay until tiers unlock
3. Tap reward nodes or **claim all**

Loot bags from pass rewards are generated when pending rewards are prepared; player opens them at **Season Pass** location or home depending on client flow.

## Player states that block rewards

Season pass user instance states include:

- `NotJoined` — must join the pass
- `ForfeitedTournament` — pass tournament not completed properly
- `Expired` — season pass season ended
- `RewardClaimed` — already collected for that cycle
- `CanNotJoinTournament` — cannot enter pass tournament

If state is **Expired** or **ForfeitedTournament**, player may not see claimable tournament or track rewards until support clarifies season rules.

## Season end / history pending

When a season pass season closes, unclaimed rewards may be converted to **season pass pending reward** storage for a catch-up claim (loot bags opened server-side into pending structures).

Deleting pending after claim is normal.

## Bag bonus and pending home

Like mini-games, some pass flows use **pending rewards on home** for bag bonus portions.

## "Lost" season pass reward

| Check | Action |
|-------|--------|
| Premium vs free tier | Premium rewards need pass purchased |
| Enough tokens | Tier not unlocked yet |
| Season ended | Look for pending/history claim or inbox message |
| Loot not visible | Open pending loot bags |
| Tournament leg | Did they finish pass tournament without forfeit? |

## Related

- Season events (calendar): `09-season-events-and-qualifiers.md`
- Tournaments: `02-tournaments-and-leaderboard-rewards.md`
