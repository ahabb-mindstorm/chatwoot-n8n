# Helpshift FAQ export (English)

Published FAQs exported from Helpshift `en_faqs.csv` on **2026-05-19**.

- **94** markdown files (one per FAQ ID)
- **26** unpublished/empty rows skipped in export
- Filename: `{faq_id}-{slug}.md`
- Pinecone vector id prefix: `helpshift-faq-{faq_id}--{slug}`

Regenerate:

```bash
npm run rag:export-helpshift
npm run rag:upsert-helpshift   # optional: push to Pinecone
```

Curated gameplay/troubleshooting docs remain in [`rag/`](../) (e.g. `99-troubleshooting-lost-rewards.md`).
