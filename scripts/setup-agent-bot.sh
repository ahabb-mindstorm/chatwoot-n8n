#!/usr/bin/env bash
set -euo pipefail

command -v curl >/dev/null
command -v jq >/dev/null

# Creates a Chatwoot Agent Bot and attaches it to an inbox.
# Fill env vars or export them before running.

: "${CHATWOOT_BASE_URL:?Set CHATWOOT_BASE_URL}"
: "${CHATWOOT_ACCOUNT_ID:?Set CHATWOOT_ACCOUNT_ID}"
: "${N8N_AGENT_WEBHOOK_URL:?Full URL e.g. https://n8n.example.com/webhook/chatwoot-support-bot}"
: "${CHATWOOT_INBOX_ID:?Inbox id that should use the bot}"

BOT_NAME="${BOT_NAME:-n8n Support Bot}"
BOT_DESCRIPTION="${BOT_DESCRIPTION:-n8n-powered customer support bot}"
CHATWOOT_AGENT_BOT_API="${CHATWOOT_AGENT_BOT_API:-account}"

echo "Creating agent bot..."
if [[ "${CHATWOOT_AGENT_BOT_API}" == "platform" ]]; then
  : "${CHATWOOT_PLATFORM_ACCESS_TOKEN:?Set CHATWOOT_PLATFORM_ACCESS_TOKEN for platform API mode}"
  CREATE_JSON="$(curl -fsS -X POST "${CHATWOOT_BASE_URL}/platform/api/v1/agent_bots" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${CHATWOOT_PLATFORM_ACCESS_TOKEN}" \
    -d "$(jq -nc --arg name "$BOT_NAME" --arg desc "$BOT_DESCRIPTION" --arg url "$N8N_AGENT_WEBHOOK_URL" --argjson account_id "$CHATWOOT_ACCOUNT_ID" '{name:$name, description:$desc, outgoing_url:$url, account_id:$account_id}')")"
else
  : "${CHATWOOT_API_ACCESS_TOKEN:?Set CHATWOOT_API_ACCESS_TOKEN for account API mode}"
  CREATE_JSON="$(curl -fsS -X POST "${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/agent_bots" \
    -H "Content-Type: application/json" \
    -H "api_access_token: ${CHATWOOT_API_ACCESS_TOKEN}" \
    -d "$(jq -nc --arg name "$BOT_NAME" --arg desc "$BOT_DESCRIPTION" --arg url "$N8N_AGENT_WEBHOOK_URL" '{name:$name, description:$desc, outgoing_url:$url}')")"
fi

BOT_ID="$(echo "$CREATE_JSON" | jq -r '.id // .payload.id // .data.id // empty')"
ACCESS_TOKEN="$(echo "$CREATE_JSON" | jq -r '.access_token // .payload.access_token // .data.access_token // empty')"

if [[ -z "${BOT_ID}" || "${BOT_ID}" == "null" ]]; then
  echo "Unexpected create response:" >&2
  echo "$CREATE_JSON" | jq . >&2 || echo "$CREATE_JSON" >&2
  exit 1
fi

echo "Bot id: ${BOT_ID}"
if [[ -n "${ACCESS_TOKEN}" && "${ACCESS_TOKEN}" != "null" ]]; then
  echo "Bot access token issued (store as CHATWOOT_API_ACCESS_TOKEN if you use bot token for replies)."
  echo "${ACCESS_TOKEN}"
fi

echo "Attaching bot to inbox ${CHATWOOT_INBOX_ID}..."
# Application API path (uses user api_access_token); if this 404s on your version, attach via UI: Inbox -> Agent Bot.
curl -fsS -X POST "${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes/${CHATWOOT_INBOX_ID}/set_agent_bot" \
  -H "Content-Type: application/json" \
  -H "api_access_token: ${CHATWOOT_API_ACCESS_TOKEN:-${CHATWOOT_PLATFORM_ACCESS_TOKEN}}" \
  -d "$(jq -nc --argjson id "$BOT_ID" '{agent_bot:$id}')" || {
    echo "Attach via UI if endpoint missing: Inbox settings -> Bot -> select \"${BOT_NAME}\"."
  }

echo "Done."
