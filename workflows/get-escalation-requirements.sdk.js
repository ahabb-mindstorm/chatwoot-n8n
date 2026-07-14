import { workflow, node, trigger } from '@n8n/workflow-sdk';

// Deprecated: escalation is resolved inline in the main bot workflow via
// workflows/escalation-resolver.mjs. Keep this file only for legacy n8n deployments
// until existing standalone sub-workflows are removed from production.

const WORKFLOW_ID = 'YD4d0AAkcvOSSLua';
const WORKFLOW_NAME = 'Get Escalation Requirements';

const resolveEscalationRequirementsJsCode = `const input = $input.first().json || {};
const validCategories = ['purchase_payment','withdrawal','account','technical_bug','gameplay_tournament','player_report','other','reward'];
const validRewardSources = ['tournament','daily_bonus','golf_pass','topshot','loot_bag','unknown'];

let category = String(input.category || 'other').trim().toLowerCase();
if (!validCategories.includes(category)) category = 'other';
let rewardSource = String(input.reward_source || input.rewardSource || 'unknown').trim().toLowerCase();
if (!validRewardSources.includes(rewardSource)) rewardSource = 'unknown';
if (category !== 'reward') rewardSource = '';

const rewardTemplates = {
  tournament: [
    { name: 'tournament_id', label: 'Tournament ID', type: 'select', placeholder: 'Results > tournament > bottom of leaderboard', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'e.g. cash prize, coins, item' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Tell us what reward is missing' }
  ],
  daily_bonus: [
    { name: 'streak_day', label: 'Streak day', type: 'text', placeholder: 'e.g. day 7' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What should have been added?' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Did the claim fail, or was the reward not added?' }
  ],
  golf_pass: [
    { name: 'pass_level', label: 'Golf Pass level or milestone', type: 'text', placeholder: 'Level or reward milestone' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What reward is missing?' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Tell us what you saw in Golf Pass' }
  ],
  topshot: [
    { name: 'tournament_id', label: 'Tournament ID', type: 'select', placeholder: 'Results > tournament > bottom of leaderboard', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What TopShot reward is missing?' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Tell us what you expected and what appeared instead' }
  ],
  loot_bag: [
    { name: 'loot_bag_type', label: 'Loot Bag or Loot Ladder reward', type: 'text', placeholder: 'Bag type, ladder step, or reward name' },
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Item or reward missing', type: 'text', placeholder: 'What should you have received?' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Tell us what happened after opening/earning it' }
  ],
  unknown: [
    { name: 'reward_source', label: 'Which reward is missing?', type: 'select', options: [
      { label: 'Tournament or Championship', value: 'tournament' },
      { label: 'Daily Bonus', value: 'daily_bonus' },
      { label: 'Golf Pass', value: 'golf_pass' },
      { label: 'TopShot', value: 'topshot' },
      { label: 'Loot Bag or Loot Ladder', value: 'loot_bag' },
      { label: 'Other reward', value: 'other' }
    ] },
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'What reward is missing and where did you expect it?' }
  ]
};

const templates = {
  purchase_payment: [
    { name: 'email', label: 'Email linked to your payment', type: 'email', placeholder: 'you@example.com' },
    { name: 'payment_method', label: 'Payment method', type: 'select', options: [{ label: 'Apple Pay', value: 'Apple Pay' }, { label: 'PayPal', value: 'PayPal' }] },
    { name: 'offer', label: 'Offer', type: 'text', placeholder: '$5 deposit offer, coin pack' },
    { name: 'payment_date', label: 'Date of payment', type: 'text', placeholder: 'e.g. 2026-06-10' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Describe the issue' }
  ],
  withdrawal: [
    { name: 'paypal_email', label: 'PayPal email used for the withdrawal', type: 'email', placeholder: 'you@example.com' },
    { name: 'transaction_id', label: 'Transaction ID', type: 'text', placeholder: 'Transaction ID' },
    { name: 'amount', label: 'Withdrawal amount', type: 'text', placeholder: 'e.g. $25.00' },
    { name: 'request_date', label: 'Date of the withdrawal request', type: 'text', placeholder: 'e.g. 2026-06-10' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Describe the issue' }
  ],
  account: [
    { name: 'username', label: 'Username', type: 'text', placeholder: 'Your username' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'What happened?' }
  ],
  technical_bug: [
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'where_did_it_happen', label: 'Where did it happen?', type: 'text', placeholder: 'Screen, feature, or step where the issue occurred' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Steps, error messages, and what happened' }
  ],
  gameplay_tournament: [
    { name: 'tournament_id', label: 'Tournament ID (Results > tournament > bottom of leaderboard)', type: 'select', placeholder: 'Tournament ID', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'date_time', label: 'Date/time', type: 'date', placeholder: 'Date and approximate time' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'What happened?' }
  ],
  player_report: [
    { name: 'tournament_id', label: 'Tournament ID (Results > tournament > bottom of leaderboard)', type: 'select', placeholder: 'Tournament ID', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'other_player_username', label: 'Other player username', type: 'text', placeholder: 'Username of the player you are reporting' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'Cheating, harassment, unfair play, or other disruptive behavior' }
  ],
  other: [
    { name: 'email', label: 'Contact email', type: 'email', placeholder: 'you@example.com' },
    { name: 'where_did_it_happen', label: 'Where did it happen?', type: 'text', placeholder: 'Screen, feature, or step where the issue occurred' },
    { name: 'description', label: 'Description', type: 'text_area', placeholder: 'What happened?' }
  ]
};

const attachmentPrompts = {
  purchase_payment: 'Attach a receipt or payment confirmation screenshot if you have one.',
  withdrawal: 'Attach payout confirmation emails or screenshots if you have them.',
  technical_bug: 'Attach screenshots or video of the issue if you have them.',
  gameplay_tournament: 'Attach screenshots or video from the tournament or results screen if you have them.',
  player_report: 'Attach screenshots or video showing the reported behavior if you have them.',
  reward: 'Attach screenshots or video showing the missing reward or balance if you have them.',
  other: 'Attach screenshots or video if you have them.'
};

const items = category === 'reward' ? rewardTemplates[rewardSource] : templates[category];
return [{ json: {
  category,
  reward_source: rewardSource,
  items,
  required_fields: items.map((item) => item.name),
  attachment_config: {
    enabled: true,
    accept: ['image/*', 'video/*'],
    max_files: 3,
    optional: true,
    prompt: attachmentPrompts[category] || attachmentPrompts.other
  }
} }];`;

const escalationRequirementsInput = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Escalation Requirements Input',
    parameters: {
      workflowInputs: {
        values: [
          { name: 'category' },
          { name: 'reward_source' },
        ],
      },
    },
    position: [0, 0],
    id: '1a842219-42cc-4212-895b-a9427905f45d',
  },
  output: [{}],
});

const resolveEscalationRequirements = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Escalation Requirements',
    parameters: {
      jsCode: resolveEscalationRequirementsJsCode,
    },
    position: [224, 0],
    id: 'f9e0e321-3bb2-410c-b3ac-b2520d8e6eb3',
  },
  output: [{}],
});

export default workflow(WORKFLOW_ID, WORKFLOW_NAME)
  .add(escalationRequirementsInput.to(resolveEscalationRequirements));
