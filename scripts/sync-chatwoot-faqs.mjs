#!/usr/bin/env node
/**
 * Sync labeled FAQ snippets into a Chatwoot help center portal.
 *
 * Usage:
 *   node scripts/sync-chatwoot-faqs.mjs \
 *     --faq-dir ~/Downloads/progolf_faqs_snippet_by_question_number \
 *     --portal withdrawl
 *
 * Requires in .env:
 *   CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_ACCESS_TOKEN
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const CATEGORY_SPECS = [
  { name: "General", slug: "general", position: 1 },
  { name: "Account", slug: "account", position: 2 },
  { name: "Gameplay", slug: "gameplay", position: 3 },
  { name: "Payments/Withdrawls", slug: "withdrawal", position: 4 },
  { name: "Game Modes", slug: "game-modes", position: 5 },
  { name: "Equipment", slug: "equipment", position: 6 },
  { name: "Lootbags", slug: "lootbags", position: 7 },
  { name: "Golf Pass", slug: "golf-pass", position: 8 },
  { name: "Shop", slug: "shop", position: 9 },
  { name: "Personalisation", slug: "personalisation", position: 10 },
];

function loadEnv() {
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // optional .env
  }
}

function parseArgs(argv) {
  const args = {
    faqDir: join(homedir(), "Downloads/progolf_faqs_snippet_by_question_number"),
    portal: "withdrawl",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--faq-dir") args.faqDir = argv[++i];
    else if (arg === "--portal") args.portal = argv[++i];
  }
  return args;
}

function expandHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function plainToHtml(text) {
  const lines = text.split("\n");
  const blocks = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(`<ul>${listItems.map((item) => `<li><p>${item}</p></li>`).join("")}</ul>`);
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*•]\s+/, "").replace(/&/g, "&amp;").replace(/</g, "&lt;"));
      continue;
    }
    flushList();
    const escaped = trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    blocks.push(`<p>${escaped}</p>`);
  }
  flushList();
  return blocks.join("");
}

function parseFaqFile(text) {
  const categoryMatch = text.match(/^Category:\s*(.+)\s*$/m);
  const questionMatch = text.match(/^(\d+)\.\s*(.+?)\s*$/m);
  if (!categoryMatch || !questionMatch) {
    throw new Error("Missing Category or numbered question line");
  }

  const category = categoryMatch[1].trim();
  const position = Number(questionMatch[1]);
  const title = questionMatch[2].trim();
  const bodyStart = text.indexOf(questionMatch[0]) + questionMatch[0].length;
  const body = text.slice(bodyStart).replace(/^\s*\n+/, "").trim();

  return { category, position, title, body, content: plainToHtml(body) };
}

function loadFaqs(faqDir) {
  const files = readdirSync(faqDir)
    .filter((name) => name.endsWith(".txt"))
    .sort();
  return files.map((file) => {
    const text = readFileSync(join(faqDir, file), "utf8");
    return { file, ...parseFaqFile(text) };
  });
}

async function api(base, token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      api_access_token: token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

async function ensureCategories(base, token, accountId, portal) {
  const existingPayload = await api(
    base,
    token,
    `/api/v1/accounts/${accountId}/portals/${portal}/categories`,
  );
  const existing = existingPayload.payload || existingPayload || [];
  const byName = new Map(existing.map((cat) => [cat.name, cat]));
  const bySlug = new Map(existing.map((cat) => [cat.slug, cat]));
  const categoryIds = {};

  for (const spec of CATEGORY_SPECS) {
    const found = byName.get(spec.name) || bySlug.get(spec.slug);
    if (found) {
      categoryIds[spec.name] = found.id;
      console.log(`category ok  ${spec.name} (#${found.id})`);
      continue;
    }

    const created = await api(
      base,
      token,
      `/api/v1/accounts/${accountId}/portals/${portal}/categories`,
      {
        method: "POST",
        body: {
          category: {
            name: spec.name,
            slug: spec.slug,
            locale: "en",
            description: "",
            position: spec.position,
          },
        },
      },
    );
    const cat = created.payload || created;
    categoryIds[spec.name] = cat.id;
    console.log(`category new ${spec.name} (#${cat.id})`);
  }

  return categoryIds;
}

async function resolveAuthorId(base, token, accountId) {
  const profile = await api(base, token, "/api/v1/profile");
  if (profile?.id) return profile.id;

  const agents = await api(base, token, `/api/v1/accounts/${accountId}/agents`);
  const list = Array.isArray(agents) ? agents : agents.payload || [];
  const admin = list.find((agent) => agent.role === "administrator") || list[0];
  if (!admin?.id) throw new Error("Could not resolve author_id from profile or agents");
  return admin.id;
}

async function listArticles(base, token, accountId, portal) {
  const articles = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await api(
      base,
      token,
      `/api/v1/accounts/${accountId}/portals/${portal}/articles?page=${page}`,
    );
    const batch = payload.payload || [];
    articles.push(...batch);
    if (batch.length < 25) break;
  }
  return articles;
}

async function deleteArticles(base, token, accountId, portal, articles, dryRun) {
  console.log(`Deleting ${articles.length} existing articles...`);
  for (const article of articles) {
    if (dryRun) {
      console.log(`  dry-run delete #${article.id} ${article.title}`);
      continue;
    }
    await api(
      base,
      token,
      `/api/v1/accounts/${accountId}/portals/${portal}/articles/${article.id}`,
      { method: "DELETE" },
    );
    console.log(`  deleted #${article.id} ${article.title}`);
  }
}

async function uploadFaqs(base, token, accountId, portal, faqs, categoryIds, authorId, dryRun) {
  console.log(`Uploading ${faqs.length} articles...`);
  const created = [];

  for (const faq of faqs.sort((a, b) => a.position - b.position)) {
    const categoryId = categoryIds[faq.category];
    if (!categoryId) {
      throw new Error(`Unknown category "${faq.category}" for ${faq.file}`);
    }

    const payload = {
      title: faq.title,
      slug: `${String(faq.position).padStart(3, "0")}-${slugify(faq.title)}`,
      content: faq.content,
      description: "",
      category_id: categoryId,
      author_id: authorId,
      position: faq.position,
      locale: "en",
      status: 1,
    };

    if (dryRun) {
      console.log(`  dry-run create [${faq.category}] ${faq.position}. ${faq.title}`);
      continue;
    }

    const result = await api(
      base,
      token,
      `/api/v1/accounts/${accountId}/portals/${portal}/articles`,
      { method: "POST", body: payload },
    );
    const article = result.payload || result;
    created.push(article);
    console.log(`  created #${article.id} [${faq.category}] ${faq.title}`);
  }

  return created;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv);
  args.faqDir = expandHome(args.faqDir);

  const base = (process.env.CHATWOOT_BASE_URL || process.env.HATWOOT_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.CHATWOOT_API_ACCESS_TOKEN;
  const accountId = process.env.CHATWOOT_ACCOUNT_ID || "1";

  if (!base || !token) {
    throw new Error("Set CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN in .env");
  }

  const faqs = loadFaqs(args.faqDir);
  console.log(`Loaded ${faqs.length} FAQ files from ${args.faqDir}`);
  console.log(`Portal: ${args.portal}  Account: ${accountId}  Base: ${base}`);
  if (args.dryRun) console.log("DRY RUN — no writes");

  const categoryIds = args.dryRun
    ? Object.fromEntries(CATEGORY_SPECS.map((spec) => [spec.name, 0]))
    : await ensureCategories(base, token, accountId, args.portal);

  const authorId = args.dryRun ? 0 : await resolveAuthorId(base, token, accountId);
  if (!args.dryRun) console.log(`Author ID: ${authorId}`);

  const existingArticles = args.dryRun ? [] : await listArticles(base, token, accountId, args.portal);
  await deleteArticles(base, token, accountId, args.portal, existingArticles, args.dryRun);
  await uploadFaqs(base, token, accountId, args.portal, faqs, categoryIds, authorId, args.dryRun);

  if (!args.dryRun) {
    const finalArticles = await listArticles(base, token, accountId, args.portal);
    console.log(`\nDone. Portal now has ${finalArticles.length} articles.`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
