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
  const conversation = payload.conversation || {};
  const lastConversationMessage = Array.isArray(conversation.messages)
    ? conversation.messages.find((item) => String(item.id) === String(message.id || payload.id)) ||
      conversation.messages[0] ||
      {}
    : {};
  const sender = message.sender || payload.sender || payload.contact || {};
  const senderType = String(
    sender.type ||
      message.sender_type ||
      payload.sender_type ||
      message.senderType ||
      payload.senderType ||
      lastConversationMessage.sender_type ||
      lastConversationMessage.sender?.type ||
      conversation.meta?.sender?.type ||
      (payload.contact ? "contact" : ""),
  ).toLowerCase();
  const isContact = senderType === "contact";
  const mt = message.message_type ?? payload.message_type;
  const isIncoming = mt === 0 || mt === "0" || String(mt).toLowerCase() === "incoming";
  const isPrivate = message.private === true || payload.private === true;
  if (isPrivate || !isContact || !isIncoming) {
    return { ok: false, reason: "not_customer_incoming" };
  }

  const account = payload.account || {};
  const accountId = account.id;
  const conversationId = conversation.id || conversation.display_id || payload.conversation_id;
  const messageId = message.id || payload.id;
  const userText = String(message.content || payload.content || "").trim();
  const inbox = payload.inbox || {};
  const contact =
    payload.contact ||
    (senderType === "contact" && sender.type ? sender : undefined) ||
    conversation.meta?.sender ||
    lastConversationMessage.sender ||
    {};

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
      contactId: contact.id || conversation.contact_inbox?.contact_id || lastConversationMessage.sender_id,
      senderType,
    },
  };
}
