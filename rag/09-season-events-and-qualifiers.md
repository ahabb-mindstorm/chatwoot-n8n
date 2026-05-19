---
topic: season-events
keywords: season event, qualifier, calendar, seasonal tournament, season history reward, Q school, earnings
---

# Season events and qualifiers

**Season events** are calendar-driven competitive content (qualifiers, seasonal tournaments, earnings leaderboards) distinct from the **Season Pass** battle pass track.

## Seasonal tournament prizes

Season event tournaments distribute **rank rewards** when the event tournament completes:

- Players who **do not complete** the event tournament (state not completed) are treated as **not eligible** for rank prizes in reward calculation
- Prizes are associated with type **Season Event Tournament Winning**

Players claim through **season event UI** / history flows (similar to claiming seasonal headings), not always the same as career tournament history.

## History rewards → inbox

If a player did not claim seasonal prizes before season rollover, the server can post a **news/inbox message** prompting them to claim **history rewards** for that season. This is intentional catch-up — not automatic wallet credit.

## Earnings leaderboards

**Global / seasonal / Q-School earnings leaderboards** track earnings over a period. When a season or period **resets**:

- Leaderboard positions finalize
- Any configured reset rewards are distributed per live-ops rules

Players asking about "missing leaderboard prize" should confirm the **reset already happened** and whether their rank qualified.

## Qualifiers and calendar

The season **calendar** shows active and upcoming events. Rewards are tied to specific **event IDs**. Support needs the event name/date the player played.

## Seasonal equipment

Some seasons grant **seasonal equipment** rewards (migration or event rewards). Types include `SeasonalEquipmentReward` in pending rewards.

## vs. Career tournaments

| Career tournament | Season event tournament |
|-------------------|-------------------------|
| Standard history | Event ID based |
| Pending types: TournamentCompletion / TournamentWinning | SeasonalTournamentCompletion / SeasonEventTournamentWinning |

Wrong screen = "can't find reward."

## Troubleshooting

1. Confirm **event** vs **career** tournament
2. Did player **complete** all required holes?
3. Claim in **season results** or **inbox** for history
4. Open **loot bags** on home after claim
