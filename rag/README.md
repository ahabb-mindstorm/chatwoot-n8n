# Pro Golf — Customer Support RAG Knowledge Base

These markdown files are written for **Pinecone (or similar vector) upload** to answer player questions such as *"I lost my reward"*, *"Where is my loot bag?"*, or *"Why didn't I get tournament prizes?"*.

## Recommended upload setup

| Setting | Suggestion |
|--------|------------|
| **Chunk size** | 400–800 tokens; split on `##` headings if files are large |
| **Metadata** | `topic`, `feature`, `keywords` (from each file's front matter block) |
| **Embedding model** | Your standard text embedding model; these docs are plain English |
| **Namespace** | Optional: `player-support` vs `internal` if you add engineer docs later |

## File index (upload all for full coverage)

| File | Topics / keywords |
|------|-------------------|
| `00-reward-system-overview.md` | rewards, pending, claim, wallet, currencies |
| `01-home-screen-and-pending-rewards.md` | home, main screen, claim all, pending rewards, bag bonus |
| `02-tournaments-and-leaderboard-rewards.md` | tournament, forfeit, rank prize, history, cancelled |
| `03-loot-bags.md` | loot bag, lootbag, pending loot, open, equipment |
| `04-daily-rewards.md` | daily reward, streak, timer, expired |
| `05-news-and-inbox.md` | news, inbox, message, claim reward |
| `06-best-shot-top-shot.md` | best shot, top shot, share reward |
| `07-mini-games-pro-shot-speed-putt.md` | pro shot, speed putt, mini game, forfeit |
| `08-season-pass.md` | season pass, premium, track rewards |
| `09-season-events-and-qualifiers.md` | season event, qualifier, calendar |
| `10-challenges.md` | challenge, lobby, entry fee refund |
| `11-career-progression-level-rewards.md` | level up, career, XP, league |
| `12-shop-payments-referrals.md` | shop, purchase, deposit, referral, reimbursement |
| `99-troubleshooting-lost-rewards.md` | lost reward, missing, not received, FAQ |

## Helpshift export (`helpshift/`)

English FAQs from Helpshift CSV (`en_faqs.csv`, 2026-05-19): **94** files, one per published FAQ.

```bash
npm run rag:export-helpshift    # regenerate rag/helpshift/*.md from CSV paths in script defaults
npm run rag:upsert-helpshift  # embed + upsert to Pinecone (helpshift-faq-* ids)
```

See [`helpshift/README.md`](helpshift/README.md) for naming and Pinecone id conventions.

## Source of truth

Content is derived from the Pro Golf Nakama server codebase (`src/modules/`) as of the documentation generation date. Config timers (daily reward expiry, inbox duration) are **config-driven** — tell players approximate behavior, not exact seconds unless you sync config values into metadata.
