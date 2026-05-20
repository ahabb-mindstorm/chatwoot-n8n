/**
 * Helpshift CSV → RAG chunks (shared by upsert + markdown export scripts).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const MAX_CHUNK_CHARS = 2800;

const SECTION_TOPIC = {
  General: { topic: "general", feature: "general" },
  Account: { topic: "account", feature: "account" },
  Payments: { topic: "payments", feature: "payments" },
  Gameplay: { topic: "gameplay", feature: "gameplay" },
  "Game Modes": { topic: "game_modes", feature: "game_modes" },
  Equipment: { topic: "equipment", feature: "equipment" },
  LootBags: { topic: "loot_bags", feature: "loot_bags" },
  "Golf Pass": { topic: "season_pass", feature: "season_pass" },
  Shop: { topic: "shop", feature: "shop" },
  Personalization: { topic: "personalization", feature: "personalization" },
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || (c === "\r" && next === "\n")) {
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      if (c === "\r") i++;
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }

  return rows;
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    return obj;
  });
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55);
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function inferTopic(title, body) {
  const blob = `${title} ${body}`.toLowerCase();

  if (/lost reward|missing (prize|reward)|didn't get|not received|pending reward/.test(blob)) {
    return { topic: "troubleshooting", feature: "lost_rewards" };
  }
  if (/withdraw|deposit|paypal|payment|wallet|billing|refund/.test(blob)) {
    return SECTION_TOPIC.Payments;
  }
  if (/loot bag|club card|equipment|tour bag|multiplier/.test(blob)) {
    return SECTION_TOPIC.Equipment;
  }
  if (/golf pass|season pass/.test(blob)) {
    return SECTION_TOPIC["Golf Pass"];
  }
  if (/shop|offer|purchase|cosmetic/.test(blob)) {
    return SECTION_TOPIC.Shop;
  }
  if (/daily bonus|daily reward/.test(blob)) {
    return { topic: "daily_reward", feature: "daily_rewards" };
  }
  if (/inbox|news|notification|push/.test(blob)) {
    return { topic: "news_inbox", feature: "news_inbox" };
  }
  if (/championship|season event|qualif|ticket/.test(blob)) {
    return { topic: "season_event", feature: "season_events" };
  }
  if (/pro shot|speed putt|mini.game|topshot|top shot/.test(blob)) {
    return { topic: "mini_game", feature: "mini_games" };
  }
  if (/level up|xp|career reward|career/.test(blob)) {
    return SECTION_TOPIC.Gameplay;
  }
  if (/tournament|leaderboard|entry fee|prize pool|matchmaking|forfeit/.test(blob)) {
    return SECTION_TOPIC["Game Modes"];
  }
  if (/register|account|login|otp|phone/.test(blob)) {
    return SECTION_TOPIC.Account;
  }
  if (/legal|gambling|skill/.test(blob)) {
    return SECTION_TOPIC.General;
  }

  return SECTION_TOPIC.General;
}

export function inferGameContexts(title, body) {
  const t = `${title} ${body}`.toLowerCase();
  const contexts = new Set();

  if (/tournament|championship|leaderboard|entry fee|prize pool|forfeit/.test(t)) {
    contexts.add("tournament");
  }
  if (/home|main screen|pending reward|claim pending|loot bag/.test(t)) {
    contexts.add("main_screen");
  }
  if (/inbox|news message|notification/.test(t)) {
    contexts.add("news_inbox");
  }
  if (/loot bag|open bag|club card/.test(t)) {
    contexts.add("loot_bags");
  }
  if (/daily bonus|daily reward|login streak/.test(t)) {
    contexts.add("daily_reward");
  }
  if (/pro shot|speed putt|mini.game|putting/.test(t)) {
    contexts.add("mini_game");
  }
  if (/season pass|golf pass/.test(t)) {
    contexts.add("season_pass");
  }
  if (/season event|qualif|championship ticket/.test(t)) {
    contexts.add("season_event");
  }
  if (/challenge/.test(t)) {
    contexts.add("challenge");
  }
  if (/career|level up|xp/.test(t)) {
    contexts.add("career");
  }
  if (/shop|withdraw|deposit|wallet|purchase/.test(t)) {
    contexts.add("shop");
  }
  if (/best shot|top shot/.test(t)) {
    contexts.add("tournament");
  }

  if (contexts.size === 0) contexts.add("main_screen");
  return [...contexts];
}

export function extractTips(text) {
  const tips = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-*•]\s+/.test(trimmed) && trimmed.length < 200) {
      tips.push(trimmed.replace(/^[-*•]\s+/, ""));
    }
    if (/^step \d+:/i.test(trimmed) && trimmed.length < 200) {
      tips.push(trimmed);
    }
  }
  if (tips.length === 0) {
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20 && s.length < 180);
    tips.push(...sentences.slice(0, 3));
  }
  return [...new Set(tips)].slice(0, 5);
}

export function extractKeywords(title, body) {
  const words = `${title} ${body}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const stop = new Set([
    "what",
    "when",
    "where",
    "which",
    "that",
    "this",
    "with",
    "from",
    "have",
    "your",
    "will",
    "does",
    "about",
    "there",
    "their",
    "they",
    "been",
    "into",
    "only",
    "also",
    "more",
    "some",
    "than",
    "then",
    "them",
    "these",
    "those",
    "would",
    "could",
    "should",
    "game",
    "cash",
    "real",
    "golf",
  ]);
  const freq = new Map();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);
}

function splitLongBody(title, body) {
  if (body.length <= MAX_CHUNK_CHARS) {
    return [{ part: "full", text: `# ${title}\n\n${body}` }];
  }

  const parts = [];
  const paragraphs = body.split(/\n\n+/);
  let buffer = `# ${title}\n\n`;
  let partIndex = 0;

  for (const para of paragraphs) {
    if ((buffer + para).length > MAX_CHUNK_CHARS && buffer.length > title.length + 4) {
      parts.push({ part: `p${partIndex++}`, text: buffer.trim() });
      buffer = `# ${title} (continued)\n\n${para}\n\n`;
    } else {
      buffer += `${para}\n\n`;
    }
  }
  if (buffer.trim()) parts.push({ part: `p${partIndex}`, text: buffer.trim() });
  return parts;
}

export function faqsToChunks(faqRows, sectionRows) {
  const sectionsById = Object.fromEntries(
    sectionRows.map((s) => [String(s.ID), s["EN Section Name"] || s["Original Section Name"]]),
  );

  const chunks = [];
  let skipped = 0;

  for (const row of faqRows) {
    const published = String(row["published?"] || "").toLowerCase() === "true";
    if (!published) {
      skipped++;
      continue;
    }

    const faqId = String(row.ID || "").trim();
    const title = (row["EN FAQ Title"] || row["Original FAQ Title"] || "").trim();
    const html = row["EN FAQ Content"] || row["Original FAQ Content"] || "";
    const plainBody = htmlToText(html);
    if (!title || !plainBody) {
      skipped++;
      continue;
    }

    const { topic, feature } = inferTopic(title, plainBody);
    const game_contexts = inferGameContexts(title, plainBody);
    const tips = extractTips(plainBody);
    const keywords = extractKeywords(title, plainBody);
    const parts = splitLongBody(title, plainBody);

    for (const { part, text } of parts) {
      const slug = slugify(title);
      const id =
        parts.length === 1
          ? `helpshift-faq-${faqId}--${slug}`
          : `helpshift-faq-${faqId}--${slug}--${part}`;

      chunks.push({
        id,
        title,
        topic,
        feature,
        plain_body: plainBody,
        body: text,
        text,
        faq_id: faqId,
        keywords,
        game_contexts,
        tips,
        source: "helpshift",
      });
    }
  }

  return { chunks, skipped };
}

export async function loadHelpshiftChunks({ faqsPath, sectionsPath }) {
  const faqCsv = await readFile(faqsPath, "utf8");
  const sectionCsv = await readFile(sectionsPath, "utf8");
  const faqRows = rowsToObjects(parseCsv(faqCsv));
  const sectionRows = rowsToObjects(parseCsv(sectionCsv));
  return { ...faqsToChunks(faqRows, sectionRows), faqRows, sectionRows };
}

/** One markdown file per FAQ (grouped by faq_id). */
export async function writeHelpshiftMarkdown(chunks, outDir) {
  await mkdir(outDir, { recursive: true });

  const byFaq = new Map();
  for (const chunk of chunks) {
    if (!byFaq.has(chunk.faq_id)) byFaq.set(chunk.faq_id, chunk);
  }

  const files = [];
  for (const chunk of byFaq.values()) {
    const slug = slugify(chunk.title);
    const filename = `${chunk.faq_id}-${slug}.md`;
    const pineconeId = `helpshift-faq-${chunk.faq_id}--${slug}`;

    let md = `---
topic: ${chunk.topic}
feature: ${chunk.feature}
faq_id: ${chunk.faq_id}
source: helpshift
pinecone_id: ${pineconeId}
keywords: ${chunk.keywords.join(", ")}
game_contexts: ${chunk.game_contexts.join(", ")}
---

# ${chunk.title}

${chunk.plain_body}
`;

    if (chunk.tips.length) {
      md += `\n## Quick tips (for bot)\n\n`;
      for (const tip of chunk.tips) {
        md += `- ${tip}\n`;
      }
    }

    await writeFile(join(outDir, filename), md);
    files.push(filename);
  }

  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files;
}
