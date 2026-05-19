---
topic: shop-payments
keywords: shop, purchase, deposit, wallet, referral, reimbursement, IAP, offer, tickets
---

# Shop, purchases, and account credits

## Shop offers

Purchasing **shop offers** grants configured `GlobalReward` content (currencies, equipment, loot bags). Rewards typically apply on successful purchase validation.

- Type: **WalletPurchase** in ledger/pending flows
- Loot bags → pending loot bags if included

If purchase succeeded on store but items missing: check payment validation failure, maintenance, or account suspension — not reward "loss."

## Deposits and withdrawals

- **Deposit** rewards (type Deposit) credit wallet per payment integration
- Withdrawals are separate from gameplay rewards

## Referrals

**Referral** rewards (type Referral) credit currency when referral program conditions are met. Shows in payment history as referral.

## Reimbursement

**Reimbursement** pending rewards appear when:

- Tournament **cancellation** refunds entry
- Support or system grants compensation

Player should claim on **home** pending rewards if issued as pending.

## Tournament cancellation credits

Cancelled tournaments add reimbursement pending reward and may remove unclaimed tournament pending items. Already-claimed rank cash may be **deducted** — player sees negative adjustment in history.

## Tickets

**TicketsReceived** type adds tournament tickets (v2) when granted. Collected through pending reward or direct grant flows.

## Troubleshooting purchases

| Issue | Direction |
|-------|-----------|
| Charged, no items | Receipt validation / restore purchases |
| Items in loot bags | Open pending loot bags |
| Cash wrong type | Bonus cash vs cash — payment history type |
| Referral missing | Referral criteria not met |

## Not gameplay rewards

Distinguish **real money wallet** issues from tournament loot — escalate payment team when needed.
