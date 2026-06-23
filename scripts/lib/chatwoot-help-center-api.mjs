/**
 * Chatwoot Help Center REST API helpers (published articles for pgvector sync).
 */

export async function chatwootApi(base, token, path, { method = "GET", body } = {}) {
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

export function isPublishedArticle(article) {
  const status = article?.status;
  return status === 1 || status === "published" || status === "Published";
}

export function isActivePortal(portal) {
  return portal?.archived !== true;
}

export function activePortalSlugsFromList(portals) {
  return (portals || [])
    .filter(isActivePortal)
    .map((portal) => String(portal.slug || "").trim())
    .filter(Boolean);
}

export function normalizeArticleRecord(article, portalSlug, categoryById) {
  return {
    faq_id: String(article.id),
    title: String(article.title || "").trim(),
    content: String(article.content || ""),
    slug: String(article.slug || "").trim(),
    category_name: categoryById.get(String(article.category_id)) || "",
    portal_slug: portalSlug,
    updated_at: article.updated_at || null,
  };
}

export async function listPortalSlugs(base, token, accountId) {
  const payload = await chatwootApi(base, token, `/api/v1/accounts/${accountId}/portals`);
  const portals = payload.payload || payload || [];
  return activePortalSlugsFromList(portals);
}

export async function listPublishedArticlesForPortal(base, token, accountId, portalSlug) {
  const categoriesPayload = await chatwootApi(
    base,
    token,
    `/api/v1/accounts/${accountId}/portals/${portalSlug}/categories`,
  );
  const categories = categoriesPayload.payload || categoriesPayload || [];
  const categoryById = new Map(
    categories.map((cat) => [String(cat.id), String(cat.name || "").trim()]),
  );

  const articles = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await chatwootApi(
      base,
      token,
      `/api/v1/accounts/${accountId}/portals/${portalSlug}/articles?page=${page}`,
    );
    const batch = payload.payload || [];
    for (const article of batch) {
      if (!isPublishedArticle(article)) continue;
      articles.push(normalizeArticleRecord(article, portalSlug, categoryById));
    }
    if (batch.length < 25) break;
  }
  return articles;
}

export async function fetchPublishedArticlesFromApi({
  baseUrl,
  token,
  accountId,
  portalSlug = "",
}) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (!base || !token) {
    throw new Error("CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN are required");
  }
  if (!accountId) {
    throw new Error("CHATWOOT_ACCOUNT_ID is required");
  }

  const portalSlugs = String(portalSlug || "").trim()
    ? [String(portalSlug).trim()]
    : await listPortalSlugs(base, token, accountId);

  if (portalSlugs.length === 0) {
    throw new Error("No Help Center portals found for this account");
  }

  const articles = [];
  for (const portal of portalSlugs) {
    articles.push(...(await listPublishedArticlesForPortal(base, token, accountId, portal)));
  }

  articles.sort((a, b) => Number(a.faq_id) - Number(b.faq_id));
  return articles;
}

export function resolveChatwootApiEnv(env = process.env) {
  return {
    baseUrl: (env.CHATWOOT_BASE_URL || env.HATWOOT_BASE_URL || "").replace(/\/$/, ""),
    token: String(env.CHATWOOT_API_ACCESS_TOKEN || "").trim(),
    accountId: String(env.CHATWOOT_ACCOUNT_ID || "").trim(),
    portalSlug: String(env.CHATWOOT_PORTAL_SLUG || "").trim(),
  };
}
