---
topic: mini-games
keywords: pro shot, speed putt, mini game, ring reward, forfeit, expired, free shots, claim mini game
---

# Mini-games: Pro Shot and Speed Putt

**Pro Shot** and **Speed Putt** are limited-time mini-game modes with ring or score-based prizes, often including **loot bags** and currencies.

## Earning rewards

### Pro Shot

- Player hits target **rings**; qualifying rings add entries to **available rewards** on their mini-game instance
- Loot bags in ring config are pre-opened into **pending loot bags** when the ring is won
- Player must run **claim** on the mini-game instance to collect currency and finalize available ring rewards

### Speed Putt

- Similar claim flow with Speed Putt reward types
- Bag bonus may split to **pending rewards on home**

## Bag bonus → home

When bag multiplier applies, **extra currency** from bag bonus may be placed in **pending rewards** with type Pro Shot or Speed Putt so the player collects on **home**. Base loot/currency from claim may still process in the mini-game UI.

**Common support issue:** Player got loot in mini-game but "missing" bonus cash → check **home pending rewards**.

## Forfeit (match timer)

If a Pro Shot **match** is still in "started" state when the match **complete time** passes:

- Match is marked **forfeited**
- Moved to history
- Ring rewards not earned for that incomplete match

## Mini-game instance expiry

When the **server mini-game event** ends (availability window closes):

- Active user instance may be archived to history and removed
- Comment in server: validate pending rewards on expiry — player should claim **before** event ends

If the event ended unclaimed, available ring rewards on that instance may no longer be accessible.

## Opening loot bags

Use **Mini Game** open location when claiming pending loot bags from these sources. Equipment may appear under **unviewed rewards** until viewed on home.

## Loot bag open location enum

- Home = 0
- Season Pass = 1
- Mini Game = 2

## Troubleshooting

| Report | Check |
|--------|--------|
| No reward after good shot | Ring index valid? Match forfeited on timer? |
| Event ended | Instance expired; unclaimed rings lost |
| Missing cash | Bag bonus on home pending rewards |
| Missing clubs | Pending loot bags / unviewed on home |

## Related

- Loot bags: `03-loot-bags.md`
- Home: `01-home-screen-and-pending-rewards.md`
