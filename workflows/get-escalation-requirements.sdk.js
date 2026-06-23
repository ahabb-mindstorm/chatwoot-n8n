import { workflow, node, trigger } from '@n8n/workflow-sdk';

const WORKFLOW_ID = 'YD4d0AAkcvOSSLua';
const WORKFLOW_NAME = 'Get Escalation Requirements';

const resolveEscalationRequirementsJsCode = `const input = $input.first().json || {};
const validCategories = ['purchase_payment','withdrawal','account','technical_bug','gameplay_tournament','ban_appeal','player_report','other','reward'];
const validRewardSources = ['tournament','daily_bonus','golf_pass','topshot','loot_bag','balance_reward','unknown'];

let category = String(input.category || 'other').trim().toLowerCase();
if (!validCategories.includes(category)) category = 'other';
let rewardSource = String(input.reward_source || input.rewardSource || 'unknown').trim().toLowerCase();
if (!validRewardSources.includes(rewardSource)) rewardSource = 'unknown';
if (category !== 'reward') rewardSource = '';

const rewardTemplates = {
  tournament: [
    { name: 'tournament_id', label: 'Tournament ID', type: 'select', placeholder: 'Results > tournament > bottom of leaderboard', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'when', label: 'When did the tournament end?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'e.g. cash prize, coins, item' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Tell us what reward is missing' }
  ],
  daily_bonus: [
    { name: 'bonus_date', label: 'Date you claimed the Daily Bonus', type: 'text', placeholder: 'e.g. 2026-06-14' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What should have been added?' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Did the claim fail, or was the reward not added?' }
  ],
  golf_pass: [
    { name: 'pass_level', label: 'Golf Pass level or milestone', type: 'text', placeholder: 'Level or reward milestone' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What reward is missing?' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Tell us what you saw in Golf Pass' }
  ],
  topshot: [
    { name: 'topshot_event', label: 'TopShot event or tournament', type: 'text', placeholder: 'Event name or tournament' },
    { name: 'when', label: 'When did it happen?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Reward you expected', type: 'text', placeholder: 'What TopShot reward is missing?' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Tell us what you expected and what appeared instead' }
  ],
  loot_bag: [
    { name: 'loot_bag_type', label: 'Loot Bag or Loot Ladder reward', type: 'text', placeholder: 'Bag type, ladder step, or reward name' },
    { name: 'when', label: 'When did you open or earn it?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'expected_reward', label: 'Item or reward missing', type: 'text', placeholder: 'What should you have received?' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Tell us what happened after opening/earning it' }
  ],
  balance_reward: [
    { name: 'amount', label: 'Missing amount or balance change', type: 'text', placeholder: 'e.g. $5 Bonus Cash, coins, cash balance' },
    { name: 'when', label: 'When did you notice it?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'source', label: 'Where should it have come from?', type: 'text', placeholder: 'Tournament, purchase, reward, bonus, etc.' },
    { name: 'details', label: 'What happened?', type: 'text_area', placeholder: 'Tell us what balance is wrong' }
  ],
  unknown: [
    { name: 'reward_source', label: 'Which reward is missing?', type: 'select', options: [
      { label: 'Tournament or Championship', value: 'tournament' },
      { label: 'Daily Bonus', value: 'daily_bonus' },
      { label: 'Golf Pass', value: 'golf_pass' },
      { label: 'TopShot', value: 'topshot' },
      { label: 'Loot Bag or Loot Ladder', value: 'loot_bag' },
      { label: 'Cash, Bonus Cash, or balance', value: 'balance_reward' },
      { label: 'Other reward', value: 'other' }
    ] },
    { name: 'when', label: 'When did it happen?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'details', label: 'Describe the missing reward', type: 'text_area', placeholder: 'What reward is missing and where did you expect it?' }
  ]
};

const templates = {
  purchase_payment: [
    { name: 'email', label: 'Email linked to your payment', type: 'email', placeholder: 'you@example.com' },
    { name: 'payment_method', label: 'Payment method', type: 'select', options: [{ label: 'Apple Pay', value: 'Apple Pay' }, { label: 'PayPal', value: 'PayPal' }] },
    { name: 'amount', label: 'Payment amount', type: 'text', placeholder: 'e.g. $9.99' },
    { name: 'payment_date', label: 'Date of payment', type: 'text', placeholder: 'e.g. 2026-06-10' },
    { name: 'details', label: 'What went wrong?', type: 'text_area', placeholder: 'Describe the issue' }
  ],
  withdrawal: [
    { name: 'paypal_email', label: 'PayPal email used for the withdrawal', type: 'email', placeholder: 'you@example.com' },
    { name: 'reference', label: 'Withdrawal reference number (from your confirmation email)', type: 'text', placeholder: 'Reference #' },
    { name: 'amount', label: 'Withdrawal amount', type: 'text', placeholder: 'e.g. $25.00' },
    { name: 'request_date', label: 'Date of the withdrawal request', type: 'text', placeholder: 'e.g. 2026-06-10' },
    { name: 'details', label: 'What went wrong?', type: 'text_area', placeholder: 'Describe the issue' }
  ],
  account: [
    { name: 'nickname', label: 'In-game nickname', type: 'text', placeholder: 'Your nickname' },
    { name: 'registered_contact', label: 'Registered email or phone number', type: 'text', placeholder: 'Email or phone' },
    { name: 'device', label: 'Device you play on', type: 'text', placeholder: 'e.g. iPhone 15' },
    { name: 'details', label: 'Describe the issue', type: 'text_area', placeholder: 'What happened?' }
  ],
  technical_bug: [
    { name: 'device', label: 'Device model', type: 'text', placeholder: 'e.g. iPhone 15 Pro' },
    { name: 'os_version', label: 'OS version', type: 'text', placeholder: 'e.g. iOS 19.2' },
    { name: 'app_version', label: 'Game version', type: 'text', placeholder: 'Settings > About' },
    { name: 'tournament_id', label: 'Tournament ID (if related to a tournament)', type: 'select', placeholder: 'Results > tournament > bottom of leaderboard', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'details', label: 'What happened, and how can we reproduce it?', type: 'text_area', placeholder: 'Steps, error messages, time it happened' }
  ],
  gameplay_tournament: [
    { name: 'tournament_id', label: 'Tournament ID (Results > tournament > bottom of leaderboard)', type: 'select', placeholder: 'Tournament ID', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'when', label: 'When did it happen?', type: 'text', placeholder: 'Date and approximate time' },
    { name: 'details', label: 'Describe the issue', type: 'text_area', placeholder: 'What happened?' }
  ],
  player_report: [
    { name: 'tournament_id', label: 'Tournament ID (Results > tournament > bottom of leaderboard)', type: 'select', placeholder: 'Tournament ID', options: [{ label: 'TournamentIds', value: 'TournamentIds' }] },
    { name: 'details', label: 'Describe what the other player did', type: 'text_area', placeholder: 'Cheating, harassment, unfair play, or other disruptive behavior' }
  ],
  ban_appeal: [
    { name: 'nickname', label: 'In-game nickname', type: 'text', placeholder: 'Your nickname' },
    { name: 'registered_contact', label: 'Registered email or phone number', type: 'text', placeholder: 'Email or phone' },
    { name: 'details', label: 'Why do you believe the restriction is a mistake?', type: 'text_area', placeholder: 'Tell us your side' }
  ],
  other: [
    { name: 'email', label: 'Contact email', type: 'email', placeholder: 'you@example.com' },
    { name: 'details', label: 'Describe your issue', type: 'text_area', placeholder: 'What happened?' }
  ]
};

const attachmentPrompts = {
  purchase_payment: 'Attach a receipt or payment confirmation screenshot if you have one.',
  withdrawal: 'Attach payout confirmation emails or screenshots if you have them.',
  technical_bug: 'Attach screenshots or video of the issue if you have them.',
  gameplay_tournament: 'Attach screenshots or video from the tournament or results screen if you have them.',
  player_report: 'Attach screenshots or video showing the reported behavior if you have them.',
  reward: 'Attach screenshots or video showing the missing reward or balance if you have them.',
  ban_appeal: 'Attach screenshots that support your appeal if you have them.',
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

export default workflow(WORKFLOW_NAME, WORKFLOW_ID)
  .add(escalationRequirementsInput.to(resolveEscalationRequirements));
