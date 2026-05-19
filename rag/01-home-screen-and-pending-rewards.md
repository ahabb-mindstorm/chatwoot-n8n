---
topic: home-screen
keywords: home, main screen, pending rewards, claim all, collect, unviewed rewards, bag bonus, wallet
---

# Home screen and pending rewards

The **main screen (home)** is the central place to collect rewards that were queued on the server but not yet applied to the wallet or inventory.

## What appears on home

Players may see indicators for:

1. **Pending rewards** — coins, cash, tickets, XP, direct equipment, and loot bags rolled into the pending queue
2. **Pending loot bags** — unopened bags waiting for the open animation
3. **Unviewed rewards** — club cards, balls, or tees already granted but not yet shown in UI (common after opening loot bags from Season Pass or mini-games **not** at Home)

## How to claim pending rewards

1. Open the game to the **home / main hub**
2. Use the **claim** or **collect** control for pending rewards (triggers `ClaimPendingRewardsRPC` on the server)
3. The server applies all pending items in batch: currencies to wallet, equipment to inventory, loot bags moved to **pending loot bag** list
4. **Open each loot bag** on home if clubs or consumables are still missing

After a successful claim, pending reward list should be **empty** until new activities add more.

## Fetch without claiming

The client can refresh the list without claiming via **Fetch Pending Rewards**. Use this when the UI looks out of sync after reconnecting.

## Bag bonus on home only

Some rewards (notably parts of **Pro Shot** and **Speed Putt**) put **bag bonus currency** into pending rewards intentionally so the player collects the bonus on **home**. If the player only played the mini-game and never returned home, they may think the bonus is "lost."

**Support script:** Ask if they returned to home and tapped claim after the mini-game.

## Unviewed rewards

**Unviewed rewards** are not lost inventory. They are equipment already added to the account but flagged for a reveal animation on home. If the player opened a loot bag from Season Pass or a mini-game screen, clubs may sit in unviewed until home processes the view/clear flow.

## Notifications

The server can send a **pending reward update** notification when new items are added. Players who dismiss notifications should still see the home indicator if pending data exists.

## Common "lost reward" cases on home

| Situation | Explanation |
|-----------|-------------|
| Claim button greyed out | No pending rewards; reward may be in tournament history or inbox |
| Claimed but no clubs | Open **pending loot bags** on home |
| Only got partial cash from mini-game | Base prize claimed in mini-game; **bag bonus** still in pending on home |
| Everything empty after claim | Reward was already claimed earlier; check wallet and equipment |

## Not handled on home alone

These require other screens:

- **Tournament rank prizes** — tournament history / results (then may add loot bags to home)
- **Inbox news** — must claim inside the message before expiry
- **Daily reward** — daily reward UI with its own timer
- **Season pass track** — season pass screen for tier rewards

See `99-troubleshooting-lost-rewards.md` for a decision tree.
