---
topic: news-inbox
keywords: news, inbox, message, claim reward, expired, read, seasonal history reward, notification
---

# News and inbox rewards

Players receive **news** and **inbox** messages that can include text, banners, and **claimable rewards**. This is separate from the home **pending rewards** queue until the player claims inside the message.

## Legacy news vs. inbox news

The game may use:

1. **Classic news** — user news list; marking read can auto-trigger claim on certain templates (template type 6 converts read to claimed reward)
2. **Inbox news** — structured inbox with start/end times, claim status, and force-popup rules

Support should ask which UI the player uses if unclear.

## Claiming a news reward

1. Open **News** or **Inbox**
2. Open the specific message
3. Tap **claim** (action: `ClaimedReward`)

Server immediately applies the reward (currencies, equipment, loot bags to pending loot bags, personalization).

## Expired messages — reward truly unavailable

Inbox items are only claimable while **active**:

- Current time must be between **StartTimeStamp** and **EndTimeStamp**
- Default inbox duration is **30 days** from creation if end time not set (`2592000` seconds)

If expired:

- Claim returns **no reward available**
- Item may be archived or removed on cleanup

**This is a real loss** if the player never claimed before expiry — unlike pending rewards that often persist until claimed.

## Already claimed

Second claim attempt returns **reward already claimed**. Items show claimed status in inbox.

## Season history rewards via news

When a **season ends**, unclaimed seasonal tournament prizes may be delivered as an **inbox/news message** (body text like "claim your pending reward from season X"). Player must open that message and claim — not tournament history.

## Claim when item missing

If the player tries to claim but the inbox entry was already removed (expired/archived), server may report **no reward available** even though the UI still showed a button (client cache). Ask player to restart app.

## Personalization rewards

Some news rewards unlock **profile personalization**. After claim, player may need to visit profile customization to equip — items are not "lost."

## Troubleshooting

| Report | Likely cause |
|--------|----------------|
| Message gone | Expired or archived |
| Can't claim | Outside active window or already claimed |
| Reward not in wallet | Open loot bags on home if reward had bags |
| Season prize missing | Look for season history inbox message, not career tournament history |

## Related

- Season events: `09-season-events-and-qualifiers.md`
- Home: `01-home-screen-and-pending-rewards.md`
