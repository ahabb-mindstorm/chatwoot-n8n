---
topic: loot-bags
keywords: loot bag, lootbag, open bag, pending loot bag, club cards, balls, tees, reward not found, history
---

# Loot bags

**Loot bags** are reward containers. They do not grant items until the player **opens** them. Contents are rolled based on **bag config**, **tier**, and the player's **equipped bag level** (affects shard drops).

## Player flow

1. Player earns a loot bag (tournament, daily reward, level up, news, season pass, mini-game, shop, etc.)
2. Server creates a **pending loot bag** entry with a unique **UserInstanceId**
3. Player opens the bag from **Home**, **Season Pass**, or **Mini Game** screen
4. Server distributes club cards, balls, tees (and rarely currency if configured) to inventory
5. Entry moves to **loot bag reward history**

## Where to open loot bags

| Location | When used |
|----------|-----------|
| **Home** | Default; tournament completion, daily, most sources |
| **Season Pass** | Season pass track rewards |
| **Mini Game** | Pro Shot / Speed Putt prizes |

## Unviewed rewards after opening

If the player opens a bag **not at Home** and the source was **Pro Shot**, **Speed Putt**, or **Season Pass**, equipment may be copied to **Unviewed Rewards** for home screen reveal. Items are **already on the account** — not lost.

## Double-open / "reward not found"

If the player taps open twice or the client retries with a stale ID:

- Server may return **loot bag reward not found**
- The bag may already be in **history**

**Support:** Confirm whether the bag was already opened; check club inventory and loot bag history.

## Pending loot bag list empty but player expects a bag

Possible causes:

- Parent reward (tournament claim, pending reward claim) was never completed
- Loot bag was already opened
- Tournament **completion rules** not met (par / completion count) so bag was never generated
- **Tournament cancelled** removed related pending rewards

## Rewarded Video (RV) on loot bags

Some historical loot bag entries support an extra **RV bonus** item (club card, ball, or tee) claimed once per history entry. If already claimed, RV claim fails.

## Loot bags vs. direct club cards

Some rewards grant **club cards directly** without a loot bag. Those go through pending rewards or immediate grant — not the pending loot bag queue.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| "Lost" clubs after tournament | Rank reward claimed but **bags not opened** on home |
| Bag icon gone, no items | Opened already; check inventory |
| Error opening bag | Stale ID or already claimed |
| Wrong club rarity | RNG within bag tier; bag level affects tables |

## Related

- Home pending rewards: `01-home-screen-and-pending-rewards.md`
- Tournaments: `02-tournaments-and-leaderboard-rewards.md`
