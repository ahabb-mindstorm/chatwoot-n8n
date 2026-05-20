#!/usr/bin/env node
/**
 * Export Helpshift FAQ CSVs to rag/helpshift/*.md (one file per published FAQ).
 *
 * Usage:
 *   node scripts/export-helpshift-rag-md.mjs \
 *     --faqs /path/to/en_faqs.csv \
 *     --sections /path/to/en_sections.csv \
 *     --out rag/helpshift
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHelpshiftChunks, writeHelpshiftMarkdown } from "./lib/helpshift-chunks.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "rag", "helpshift");

function parseArgs(argv) {
  const out = {
    faqs: null,
    sections: null,
    outDir: DEFAULT_OUT,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--faqs" && argv[i + 1]) out.faqs = argv[++i];
    else if (a === "--sections" && argv[i + 1]) out.sections = argv[++i];
    else if (a === "--out" && argv[i + 1]) out.outDir = argv[++i];
  }
  return out;
}

async function writeHelpshiftReadme(outDir, fileCount, skipped) {
  const readme = `# Helpshift FAQ export (English)

Published FAQs exported from Helpshift \`en_faqs.csv\` on **2026-05-19**.

- **${fileCount}** markdown files (one per FAQ ID)
- **${skipped}** unpublished/empty rows skipped in export
- Filename: \`{faq_id}-{slug}.md\`
- Pinecone vector id prefix: \`helpshift-faq-{faq_id}--{slug}\`

Regenerate:

\`\`\`bash
npm run rag:export-helpshift
npm run rag:upsert-helpshift   # optional: push to Pinecone
\`\`\`

Curated gameplay/troubleshooting docs remain in [\`rag/\`](../) (e.g. \`99-troubleshooting-lost-rewards.md\`).
`;
  await writeFile(join(outDir, "README.md"), readme);
}

async function main() {
  const args = parseArgs(process.argv);
  const faqsPath =
    args.faqs ||
    process.env.HELPSHIFT_FAQS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_faqs.csv";
  const sectionsPath =
    args.sections ||
    process.env.HELPSHIFT_SECTIONS_CSV ||
    "/Users/ahabb.abid/Downloads/algames_pro-golf_202605191540/en/en_sections.csv";

  const { chunks, skipped, faqRows } = await loadHelpshiftChunks({ faqsPath, sectionsPath });
  if (chunks.length === 0) throw new Error("No chunks produced from Helpshift CSVs");

  const files = await writeHelpshiftMarkdown(chunks, args.outDir);
  await writeHelpshiftReadme(args.outDir, files.length, skipped);

  console.log(`Wrote ${files.length} files to ${args.outDir}`);
  console.log(`Skipped ${skipped} unpublished/empty FAQs (${faqRows.length} rows in CSV)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
