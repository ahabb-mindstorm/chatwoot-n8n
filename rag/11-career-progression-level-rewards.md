---
topic: career-progression
keywords: level up, level reward, career, XP, league, claim level, progression
---

# Career progression and level rewards

Players gain **XP** from many activities (tournaments, pending reward claims, etc.) and advance **career level**. Each level can have a **level reward** configured in live-ops.

## Claiming level rewards

1. Open **career / progression** UI when a level reward is available
2. Claim specific **level number** (must be ≤ current player level)
3. Server applies reward immediately (`LevelUP` type) including loot bags → **pending loot bags**

## Already claimed

Career progress tracks `ClaimedRewardIndex`. Attempting to claim at or below an already-claimed level may fail with level errors.

## League rewards

Level rewards may unlock **league** progression displays. League reward data is attached to progress events on claim response — cosmetic/progression, not always currency.

## "Lost" level reward

| Cause | Notes |
|-------|-------|
| Level not reached yet | Cannot claim future levels |
| Already claimed | Check claimed index |
| Loot bags | Open on home after claim |
| Wrong level tapped | Payload level must match available tier |

## XP from other systems

XP can arrive bundled in tournament pending rewards and is applied when pending rewards are claimed. Player may level up **after** home claim — then return to career screen for level prize.

## Related

- Home pending: `01-home-screen-and-pending-rewards.md`
