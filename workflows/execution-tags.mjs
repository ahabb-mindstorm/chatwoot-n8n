export const WEBHOOK_EXECUTION_TAG_JS = "$execution.customData.set('webhook', 'true');";

export const AI_TRIGGERED_EXECUTION_TAG_JS = "$execution.customData.set('ai_triggered', 'true');";

export function prependJsSnippet(code, snippet) {
  const trimmed = String(code || '');
  if (!trimmed || trimmed.includes(snippet)) return trimmed;
  return `${snippet}\n${trimmed}`;
}
