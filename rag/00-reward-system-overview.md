---
topic: reward-system
keywords: reward, prizes, claim, pending, currencies, coins, cash, tickets, equipment, loot bag, missing reward
---

# How rewards work in Pro Golf (overview)

Pro Golf uses a **two-step reward model** for many features. Understanding this helps explain why something can look "lost" when it is actually **waiting to be claimed** or stored in a **secondary queue**.

## Types of rewards

Rewards can include:

- **Currencies** — coins, cash, bonus cash, tickets, season pass tokens
- **Equipment** — club cards, balls, tees, bags
- **Loot bags** — containers that must be **opened** to roll club cards and consumables (contents depend on bag tier and player bag level)
- **XP and career progress**
- **Personalization** — profile cosmetics from some sources (news, events)
- **Season pass progress** — tokens applied when certain currencies are claimed

## Two storage layers players should know

### 1. Pending rewards (home / wallet queue)

Many systems add rewards to a **Pending Rewards** list stored on the account. The player typically claims these from the **main screen (home)** via a collect or claim-all flow.

**Server RPC:** `ClaimPendingRewardsRPC` / `FetchPendingRewardsRPC`

Pending reward **types** include (not exhaustive):

| Type | Typical source |
|------|----------------|
| Tournament completion | Finishing tournament holes / milestones |
| Tournament winning | Rank prizes after tournament ends |
| Daily reward | Daily login streak |
| News | Inbox / news messages with rewards |
| Level up | Career level milestones |
| Pro Shot / Speed Putt | Mini-game prizes (sometimes bag bonus only) |
| Bag bonus | Extra currency from equipped bag multiplier |
| Referral, deposit, reimbursement | Account / payment flows |
| Best shot / best shot share | Tournament best-shot prizes |
| Season pass / season event | Seasonal content |
| Challenge / challenge returned | Friend challenges |

Until the player runs **Claim Pending Rewards**, currencies and equipment in that queue are **not** fully applied to wallet/inventory (loot bags inside pending rewards are opened into the **pending loot bag** queue — see loot bag doc).

### 2. Pending loot bags (must be opened)

When a reward includes loot bags, opening the parent reward often creates **Pending Loot Bag** entries. Each bag has a unique instance ID and must be opened separately.

**Server RPC:** `ClaimPendingLootBagRewardsRPC`

**Open locations (client):**

- **Home** — main screen
- **Season Pass** — season pass reward flow
- **Mini Game** — Pro Shot / Speed Putt screens

If a loot bag is opened **outside Home** for Pro Shot, Speed Putt, or Season Pass rewards, the equipment may go to **Unviewed Rewards** (a holding area for UI animation) until the player views them on home.

## Claim vs. lost

| Player says | Often means |
|-------------|-------------|
| "I lost my reward" | Never claimed pending reward, loot bag not opened, or reward expired (daily / inbox) |
| "Reward disappeared" | Already claimed; check wallet history, club inventory, or loot bag history |
| "Got coins but no clubs" | Loot bag still pending or contents were balls/tees only |
| "Tournament paid nothing" | Forfeited, rank too low, empty prize tier, or prize not claimed in history |

## Bag bonus (multiplier)

Players with an **equipped bag** may earn **bag bonus** extra currency on eligible reward types. For some mini-games, **only the bag bonus portion** is sent to pending rewards on the home screen; the base reward is claimed in the mini-game flow.

## Payment / wallet history

Cash and bonus cash movements are recorded in **payment history** with a type (tournament prize, challenge return, referral, etc.). Support can ask the player to check transaction history for tournament cancellations or refunds.

## Related documents

Use the topic-specific files for: tournaments, loot bags, daily rewards, news/inbox, best shot, mini-games, season pass, season events, challenges, career levels, shop/payments, and the **troubleshooting** guide.
