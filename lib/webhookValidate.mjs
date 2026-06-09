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

function submittedEntries(attrs) {
  const submitted = attrs.submitted_values || attrs.submittedValues || [];
  if (Array.isArray(submitted)) return submitted;
  if (submitted && typeof submitted === "object") {
    return Object.entries(submitted).map(([name, value]) => ({ name, value }));
  }
  return submitted ? [{ value: submitted }] : [];
}

function submissionValue(entries) {
  const first = entries[0];
  if (!first) return "";
  if (typeof first === "object") {
    return first.value || first.payload || first.title || first.name || "";
  }
  return first;
}

function formData(entries) {
  const data = {};
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const key = entry.name || entry.id || entry.key || `field_${index + 1}`;
    data[key] = entry.value ?? entry.answer ?? entry.text ?? "";
  });
  return data;
}

function collectAttachments(message, payload, lastConversationMessage = {}) {
  const sources = [
    message.attachments,
    payload.attachments,
    payload.message?.attachments,
    lastConversationMessage.attachments,
  ];
  return sources.find((value) => Array.isArray(value)) || [];
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
  const message = payload.message && typeof payload.message === "object" ? payload.message : payload;
  const contentType = message.content_type || payload.content_type;
  const contentAttributes = message.content_attributes || payload.content_attributes || {};
  const entries = submittedEntries(contentAttributes);
  const selectedValue = submissionValue(entries);
  const supportedSubmission = ["input_select", "form"].includes(contentType) && entries.length > 0;
  const hasInteractiveSubmission = payload.event === "message_updated" && supportedSubmission;

  if (payload.event !== "message_created" && !hasInteractiveSubmission) {
    return { ok: false, reason: "unsupported_event" };
  }

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
  if (isPrivate || (!hasInteractiveSubmission && (!isContact || !isIncoming))) {
    return { ok: false, reason: "not_customer_incoming" };
  }

  const account = payload.account || {};
  const accountId = account.id;
  const conversationId = conversation.id || conversation.display_id || payload.conversation_id;
  const baseMessageId = message.id || payload.id;
  const deliveryId = headers["x-chatwoot-delivery"] || payload.updated_at || payload.created_at || "";
  const interactiveText = contentType === "form" ? JSON.stringify(formData(entries)) : String(selectedValue || "").trim();
  const messageId = hasInteractiveSubmission
    ? `${baseMessageId}:${contentType}:${interactiveText}:${deliveryId}`
    : baseMessageId;
  const userText = String(hasInteractiveSubmission ? interactiveText : message.content || payload.content || "").trim();
  const attachments = collectAttachments(message, payload, lastConversationMessage);
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
      isInteractiveSubmission: Boolean(hasInteractiveSubmission),
      interactiveContentType: hasInteractiveSubmission ? contentType : null,
      submittedValues: entries,
      attachments,
      hasAttachments: attachments.length > 0,
    },
  };
}
