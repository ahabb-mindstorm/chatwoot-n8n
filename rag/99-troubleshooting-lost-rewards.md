---
topic: troubleshooting
keywords: lost reward, missing reward, didn't get reward, reward disappeared, not received, help, support, FAQ
---

# Troubleshooting: "I lost my reward" / missing prizes

Use this guide when a player says they **lost**, **never got**, or **can't find** a reward. Most cases are **unclaimed** rewards in another screen — not server deletion.

## Quick decision tree

```
Player reports missing reward
│
├─ Did they finish the activity?
│   ├─ NO (quit early, timer ran out) → Tournament/mini-game FORFEIT → often NO rank prize
│   └─ YES → continue
│
├─ Is it CURRENCY (cash/coins/tickets)?
│   ├─ Check HOME → Claim Pending Rewards
│   ├─ Check TOURNAMENT HISTORY → unclaimed rank prize
│   ├─ Check NEWS/INBOX → unclaimed message (not expired)
│   └─ Check PAYMENT / wallet history
│
├─ Is it CLUBS / balls / tees?
│   ├─ Check HOME → Pending LOOT BAGS (must OPEN each bag)
│   ├─ Check UNVIEWED REWARDS on home (after season pass / mini-game open)
│   └─ Check equipment inventory (may already be there)
│
└─ Still missing?
    ├─ Already claimed? (second claim fails silently or "already claimed")
    ├─ Tournament CANCELLED? (refund vs deduction)
    ├─ Inbox EXPIRED? (30-day default window)
    └─ Daily streak RESET? (didn't claim before expiry timer)
```

## By game area — where rewards live

| Area | Where reward waits | How player gets it |
|------|-------------------|-------------------|
| **Main screen / Home** | Pending rewards, pending loot bags, unviewed | Claim pending → open each loot bag |
| **Tournaments** | History heading unclaimed; completion bags | Claim in results / claim all |
| **Best Shot / Top Shot** | Same tournament card | Claim with tournament or best shot button |
| **News / Inbox** | Inside message until end date | Claim in message before expiry |
| **Daily reward** | Daily UI timer | Claim before streak expiry |
| **Pro Shot / Speed Putt** | Mini-game claim + home pending | Claim in event; bag bonus on home |
| **Season Pass** | Pass track / pass pending | Claim on pass screen; open bags |
| **Season events** | Event results or inbox catch-up | Season UI or inbox message |
| **Challenges** | History or fee refund | Complete challenge or check refund |
| **Level up** | Career screen | Claim level reward |
| **Shop** | Immediate or pending bags | Restore purchase; open bags |

## Real losses vs. perceived losses

### Truly unavailable (player cannot recover via claim UI)

- **Inbox/news** reward after **EndTimeStamp** passed
- **Daily reward** streak reset after **RewardExpiryDelay** without claiming
- **Mini-game** ring rewards on an **expired** event instance never claimed
- **Tournament rank prize** when player **forfeited** or rank below prize tier
- **Tournament cancelled** before claim — unclaimed pending tournament rewards removed (may get reimbursement instead)

### Not lost — wrong place

- Loot bag contents never opened (pending loot bag list)
- Bag bonus still in **pending rewards** after mini-game
- Season prize in **inbox** not tournament history
- Equipment in **unviewed rewards**
- Rank prize unclaimed in **tournament history**

### Already received

- **Reward already claimed** error on second attempt
- Loot bag **not found** — often already opened (check history/inventory)
- Wallet shows credit in **payment history**

## Questions to ask the player

1. **What were you playing?** (career tournament, season event, pro shot, daily, inbox message, etc.)
2. **What did you expect?** (cash, clubs, loot bag, tickets)
3. **Did you tap claim?** Where?
4. **Did you finish all holes / the event?**
5. **Screenshot of** tournament results, inbox, home pending icons, or error message
6. **Approximate date/time** (for inbox expiry, event end)

## Error messages players may see

| Error (concept) | Meaning for support |
|-----------------|---------------------|
| No reward available | Nothing to claim — expired, empty tier, forfeit, or wrong place |
| Reward already claimed | Already received; check inventory/history |
| No reward claimed (daily) | Cooldown not ready |
| Loot bag reward not found | Bag already opened or invalid ID |
| History tournament not found | Wrong tournament ID or type |
| Payload invalid | Client bug or outdated app — force update |

## Escalation hints for internal teams

- Compare **wallet ledger** and **payment history** types for the user ID and time range
- Check **pending rewards** storage empty vs. player claim timestamp
- Check **pending loot bag** list and **loot bag history**
- For tournaments: forfeited flag, rank, `IsClaimed` on history heading
- For inbox: item `EndTimeStamp` vs claim time

## Synonyms for search (RAG)

Players may say: lost reward, missing prize, didn't get loot, bag didn't give clubs, tournament didn't pay, top shot reward, free daily gone, inbox gift expired, season pass tier missing, challenge money gone, purchase not delivered.

Point each synonym to the **area table** above before assuming account data loss.
