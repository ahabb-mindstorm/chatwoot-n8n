/**
 * Mirrors workflows/chatwoot-support-bot.json Validate & Normalize rules.
 */

function lowerHeaders(headers) {
  const result = {};
  Object.keys(headers || {}).forEach((k) => {
    result[String(k).toLowerCase()] = headers[k];
  });
  return result;
}

export function validateAgentBotEnvelope(root, env = {}) {
  const headers = lowerHeaders(root.headers);
  const secret = env.CHATWOOT_WEBHOOK_SECRET;
  if (secret) {
    const got = headers["x-webhook-secret"] || headers["x-chatwoot-secret"];
    if (String(got || "") !== String(secret)) {
      return { ok: false, reason: "bad_secret" };
    }
  }

  const payload = root.body && typeof root.body === "object" ? root.body : root;
  if (payload.event !== "message_created") {
    return { ok: false, reason: "unsupported_event" };
  }

  const message = payload.message && typeof payload.message === "object" ? payload.message : payload;
  const sender = message.sender || payload.sender || payload.contact || {};
  const senderType = sender.type || (payload.contact ? "contact" : undefined);
  const isContact = senderType === "contact";
  const mt = message.message_type ?? payload.message_type;
  const isIncoming = mt === 0 || mt === "0" || String(mt).toLowerCase() === "incoming";
  const isPrivate = message.private === true || payload.private === true;
  if (isPrivate || !isContact || !isIncoming) {
    return { ok: false, reason: "not_customer_incoming" };
  }

  const account = payload.account || {};
  const conversation = payload.conversation || {};
  const accountId = account.id;
  const conversationId = conversation.id || conversation.display_id;
  const messageId = message.id || payload.id;
  const userText = String(message.content || payload.content || "").trim();
  const inbox = payload.inbox || {};
  const contact = payload.contact || (senderType === "contact" ? sender : {});

  if (!accountId || !conversationId || !messageId) {
    return { ok: false, reason: "missing_ids" };
  }

  return {
    ok: true,
    data: {
      accountId,
      conversationId,
      messageId,
      userText,
      inboxId: conversation.inbox_id || inbox.id,
      contactId: contact.id,
      senderType,
    },
  };
}
