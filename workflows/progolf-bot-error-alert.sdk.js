import { workflow, node, trigger } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'progolf-bot-error-alert';
const WORKFLOW_NAME = 'ProGolf Bot Error Alerts';

const shapeSlackErrorJsCode = `const root = $input.first().json || {};
const execution = root.execution && typeof root.execution === 'object' ? root.execution : {};
const triggerError = root.trigger && typeof root.trigger === 'object' ? root.trigger.error : null;
const error = execution.error || triggerError || root.error || {};
const cause = error.cause && typeof error.cause === 'object' ? error.cause : {};
const workflow = root.workflow && typeof root.workflow === 'object' ? root.workflow : {};

function clean(value, limit) {
  return String(value || '')
    .replace(/[\\r\\n\\t]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function slackEscape(value, limit) {
  return clean(value, limit)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const workflowName = slackEscape(workflow.name || 'Unknown workflow', 160);
const workflowId = slackEscape(workflow.id || 'unknown', 80);
const executionId = slackEscape(execution.id || 'unknown', 80);
const mode = slackEscape(execution.mode || root.trigger?.mode || 'unknown', 40);
const failedNode = slackEscape(
  execution.lastNodeExecuted || error.node?.name || cause.node?.name || 'unknown',
  160,
);
const errorClass = slackEscape(error.name || cause.name || 'Error', 80);
const message = slackEscape(error.message || cause.message || 'No error message was supplied.', 700);
const executionUrl = clean(execution.url, 500);

const conversationCandidates = [
  root.conversationId,
  root.context?.conversationId,
  execution.context?.conversationId,
];
const conversationId = conversationCandidates
  .map((value) => clean(value, 64))
  .find((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)) || '';

const lines = [
  ':rotating_light: *ProGolf bot workflow failure*',
  '*Workflow:* ' + workflowName + ' (' + workflowId + ')',
  '*Execution:* ' + executionId + ' · ' + mode,
  '*Node:* ' + failedNode,
  '*Error:* ' + errorClass + ': ' + message,
];
if (conversationId) lines.push('*Conversation:* ' + slackEscape(conversationId, 64));
if (/^https?:\\/\\/[^\\s]+$/i.test(executionUrl)) lines.push('*Execution link:* ' + executionUrl);

return [{
  json: {
    text: lines.join('\\n'),
    workflowId,
    executionId,
    failedNode,
    errorClass,
    conversationId: conversationId || null,
  },
}];`;

const workflowError = trigger({
  type: 'n8n-nodes-base.errorTrigger',
  version: 1,
  config: {
    name: 'Workflow Error',
    parameters: {},
    position: [0, 0],
    id: 'progolf-error-trigger',
  },
  output: [{}],
});

const shapeSlackError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape Slack Error',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: shapeSlackErrorJsCode,
    },
    position: [240, 0],
    id: 'progolf-shape-slack-error',
  },
  output: [{}],
});

const sendSlackAlert = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Slack Alert',
    parameters: {
      method: 'POST',
      url: '={{ $env.SLACK_ALERT_WEBHOOK_URL }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ text: $json.text }) }}',
      options: {
        timeout: 8000,
      },
    },
    position: [480, 0],
    retryOnFail: {
      maxTries: 2,
      waitBetweenTries: 1500,
    },
    id: 'progolf-send-slack-alert',
  },
  output: [{}],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(workflowError.to(shapeSlackError.to(sendSlackAlert)));
