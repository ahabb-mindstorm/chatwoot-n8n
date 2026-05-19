---
topic: challenges
keywords: challenge, friend challenge, lobby, entry fee, refund, expired, rejected, cancelled, challenge returned
---

# Friend challenges

**Challenges** let players create private tournaments with friends. Entry fees are held in the lobby until the challenge resolves.

## Rewards

- **Tournament winning** rewards apply when the challenge tournament completes and rank prizes are claimed (similar to career tournaments, with challenge metadata)
- Bag bonus may apply to rank rewards

## Challenge expired / rejected / cancelled

When a challenge lobby **expires**, is **rejected**, or is **cancelled**:

- **Joined players** receive a **refund** of entry fee (cash type may credit as bonus cash)
- Refund uses currency update type **Challenge Return**
- **Cancel** may deduct a configured **percentage** of entry fee before refund

This is not a "prize" — players may think they "lost" money if they expected winnings but the challenge never started.

## No refund scenarios

If the challenge **completed** normally, entry fees are consumed and rank prizes apply — no automatic refund.

## Pending reward type

- `Challenge` — challenge-related prize
- `ChallengeReturned` — returned entry fee (if surfaced as pending)

## Troubleshooting

| Player says | Explain |
|-------------|---------|
| Lost entry fee | Challenge expired/cancelled with deduction, or never joined |
| No prize | Challenge didn't finish or they forfeited |
| Got partial refund | Cancel fee from configs |
| Prize in history | Claim tournament result for that challenge ID |

## Related

- Tournaments: `02-tournaments-and-leaderboard-rewards.md`
