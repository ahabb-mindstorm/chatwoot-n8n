import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const CATEGORY_LABELS = [
  "purchase_payment",
  "withdrawal",
  "account",
  "technical_bug",
  "gameplay_tournament",
  "ban_appeal",
  "player_report",
  "reward",
  "other",
  "bot_escalated",
];

async function loadEnv() {
  try {
    const envPath = join(root, ".env");
    const text = readFileSync(envPath, "utf8");
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

async function ensureLabel(base, token, accountId, title) {
  const listUrl = `${base}/api/v1/accounts/${accountId}/labels`;
  const listRes = await fetch(listUrl, { headers: { api_access_token: token } });
  if (listRes.ok) {
    const payload = await listRes.json();
    const existing = (payload.payload || []).find((label) => label.title === title);
    if (existing) {
      console.log(`ok ${title} (exists)`);
      return;
    }
  }

  const createRes = await fetch(listUrl, {
    method: "POST",
    headers: {
      api_access_token: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      description: `Support bot category label: ${title}`,
      color: "#1D4ED8",
      show_on_sidebar: true,
    }),
  });

  const text = await createRes.text();
  if (createRes.ok) {
    console.log(`ok ${title} (created)`);
    return;
  }
  if (createRes.status === 422 && /already been taken|already exists/i.test(text)) {
    console.log(`ok ${title} (already exists)`);
    return;
  }
  throw new Error(`Failed to create label ${title}: ${createRes.status} ${text.slice(0, 300)}`);
}

await loadEnv();

const base = process.env.CHATWOOT_BASE_URL?.replace(/\/$/, "");
const token = process.env.CHATWOOT_API_ACCESS_TOKEN;
const accountId = process.env.CHATWOOT_ACCOUNT_ID || "1";

if (!base || !token) {
  console.error("Set CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN in .env before running.");
  console.error("Required labels:", CATEGORY_LABELS.join(", "));
  process.exit(1);
}

for (const title of CATEGORY_LABELS) {
  await ensureLabel(base, token, accountId, title);
}

console.log("All category labels verified.");
