const baseUrl = String($env.CHATWOOT_BASE_URL || '').replace(/\/$/, '');
const token = String($env.CHATWOOT_API_ACCESS_TOKEN || '').trim();
const accountId = String($env.CHATWOOT_ACCOUNT_ID || '').trim();
const portalFilter = String($env.CHATWOOT_PORTAL_SLUG || '').trim();
const httpRequest = this.helpers.httpRequest.bind(this.helpers);

if (!baseUrl || !token) {
  throw new Error('CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN are required on the n8n container');
}
if (!accountId) {
  throw new Error('CHATWOOT_ACCOUNT_ID is required on the n8n container');
}

async function chatwootApi(path) {
  return httpRequest({
    method: 'GET',
    url: baseUrl + path,
    headers: { api_access_token: token },
    json: true,
  });
}

function isPublished(status) {
  return status === 1 || status === 'published' || status === 'Published';
}

async function listPortalSlugs() {
  const payload = await chatwootApi('/api/v1/accounts/' + accountId + '/portals');
  const portals = payload.payload || payload || [];
  return portals
    .filter((portal) => portal.archived !== true)
    .map((portal) => String(portal.slug || '').trim())
    .filter(Boolean);
}

async function listArticlesForPortal(portalSlug) {
  const categoriesPayload = await chatwootApi(
    '/api/v1/accounts/' + accountId + '/portals/' + portalSlug + '/categories',
  );
  const categories = categoriesPayload.payload || categoriesPayload || [];
  const categoryById = new Map(
    categories.map((cat) => [String(cat.id), String(cat.name || '').trim()]),
  );

  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await chatwootApi(
      '/api/v1/accounts/' + accountId + '/portals/' + portalSlug + '/articles?page=' + page,
    );
    const batch = payload.payload || [];
    for (const article of batch) {
      if (!isPublished(article.status)) continue;
      rows.push({
        faq_id: String(article.id),
        title: String(article.title || '').trim(),
        content: String(article.content || ''),
        slug: String(article.slug || '').trim(),
        category_name: categoryById.get(String(article.category_id)) || '',
        portal_slug: portalSlug,
        updated_at: article.updated_at || null,
      });
    }
    if (batch.length < 25) break;
  }
  return rows;
}

const portalSlugs = portalFilter ? [portalFilter] : await listPortalSlugs();
if (portalSlugs.length === 0) {
  throw new Error('No Help Center portals found for account ' + accountId);
}

const articles = [];
for (const portalSlug of portalSlugs) {
  articles.push(...(await listArticlesForPortal(portalSlug)));
}
articles.sort((a, b) => Number(a.faq_id) - Number(b.faq_id));

return articles.map((row) => ({ json: row }));
