#!/usr/bin/env node
/**
 * Browser regression runner for tests.md (excluding Suite 13).
 * Fresh player_id per scenario. Requires: npx playwright install chromium
 */
import { chromium } from 'playwright';

const BASE = 'https://support.progolf.cash/?player_name=TestPlayer&support_landing_source=main_menu';

const SCENARIOS = [
  { id: '1.1', pid: 9402, turns: ['hi'] },
  { id: '1.2', pid: 9403, turns: ['what are coins for?'] },
  { id: '2.1', pid: 9404, turns: ['what is mitosis?'] },
  { id: '2.2', pid: 9405, turns: ["I didn't get my tournament reward", 'what is mitosis?'] },
  { id: '2.3-matchmaking', pid: 9406, turns: ['how does matchmaking work?'] },
  { id: '2.3-clubs', pid: 9407, turns: ['what are clubs for?'] },
  { id: '2.3-minigames', pid: 9408, turns: ['what are minigames?'] },
  { id: '2.3-coins', pid: 9409, turns: ['what are coins for?'] },
  { id: '3.1', pid: 9410, turns: ['how to increase shot distance on my club?'] },
  { id: '3.2', pid: 9411, turns: ['can i add more spin with club upgrades?'] },
  { id: '3.3', pid: 9412, turns: ['where do i submit the clubs to enter?'] },
  { id: '3.4', pid: 9413, turns: ['how can i play a tournament?'] },
  { id: '4.1', pid: 9414, turns: ['reward'] },
  { id: '4.2', pid: 9415, turns: ['i lost my money'] },
  { id: '4.3', pid: 9416, turns: ["I didn't get my tournament cash", 'tournament reward', 'the $4 tournament'] },
  { id: '4.4', pid: 9417, turns: ['I am missing my tournament reward', 'I should get $1'] },
  { id: '4.5', pid: 9418, turns: ['I am missing my tournament reward', '$1', 'still didn\'t get it'] },
  { id: '5.1', pid: 9419, turns: ['daily reward', "i didn't get it"] },
  { id: '5.2', pid: 9420, turns: ['I missed my 3rd tier lootbag reward', 'golf pass'] },
  { id: '5.3', pid: 9421, turns: ["I didn't get my club bonus", "still didn't get the bonus from it"] },
  { id: '6.1', pid: 9422, turns: ['I missed my tournament reward yesterday, tournament 123, expected $1'] },
  { id: '6.2', pid: 9423, turns: ['Apple Pay $9.99 yesterday didn\'t show up'] },
  { id: '6.3', pid: 9424, turns: ['My PayPal withdrawal reference WD123 for $10 requested yesterday still hasn\'t arrived. My PayPal email is test@example.com.'] },
  { id: '8.1', pid: 9425, turns: ['I am missing a tournament reward'] },
  { id: '9.1', pid: 9426, turns: ['what is the wind penalty modifier in tournaments?'] },
  { id: '11.2', pid: 9427, turns: ['daily reward', "i didn't get it"] },
  { id: '11.3', pid: 9428, turns: ['daily reward', 'what are clubs for?'] },
  { id: '12.1', pid: 9429, turns: ['My PayPal withdrawal reference WD456 for $10 requested yesterday still hasn\'t arrived. My PayPal email is test2@example.com.'] },
];

async function openChat(page) {
  await page.getByRole('button', { name: 'Chat with support' }).click({ timeout: 15000 });
  await page.getByPlaceholder('Type a message…').waitFor({ timeout: 10000 });
}

async function sendAndWait(page, text) {
  const input = page.getByPlaceholder('Type a message…');
  const before = await page.locator('.justify-start .whitespace-pre-wrap').count();
  await input.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('.justify-start .whitespace-pre-wrap').length > n,
    before,
    { timeout: 45000 },
  ).catch(() => page.waitForTimeout(5000));
  await page.waitForTimeout(2000);
  const bot = await page.locator('.justify-start .whitespace-pre-wrap').allTextContents();
  return bot.map((t) => t.trim()).filter(Boolean);
}

function grade(scenario, botTexts) {
  const last = botTexts.at(-1) || '';
  const all = botTexts.join('\n').toLowerCase();

  if (scenario.id === '1.1') {
    if (/hello again/i.test(last)) return { grade: 'Minor', note: 'Redundant greeting after auto-greeting' };
    if (/help with|what.*issue|need help/i.test(last)) return { grade: 'Pass', note: 'Warm greeting' };
    return { grade: 'Minor', note: last.slice(0, 120) };
  }
  if (scenario.id === '2.1' || scenario.id === '2.2' && scenario.turns.at(-1)?.includes('mitosis')) {
    if (/mitosis|cell division|biology/i.test(last) && !/pro golf|real cash/i.test(last.slice(0, 40))) return { grade: 'Fail', note: 'Answered biology' };
    if (/pro golf|real cash|can't help|outside/i.test(last)) return { grade: 'Pass', note: 'Scope boundary' };
    return { grade: 'Minor', note: last.slice(0, 120) };
  }
  if (scenario.id.startsWith('3.')) {
    const bad = [/upgrade.*(?:distance|shot distance)|increase.*(?:shot )?distance|better performance|add more spin|automatically checks your inventory/i];
    const good = [/does not.*spin|no.*distance|faq does not|not support/i];
    if (bad.some((r) => r.test(all)) && !good.some((r) => r.test(all))) return { grade: 'Fail', note: 'Unsupported equipment claim' };
    if (last === scenario.turns.at(-1)) return { grade: 'Blocked', note: 'No bot reply detected' };
    return { grade: 'Pass', note: 'Conservative equipment answer' };
  }
  if (scenario.id === '4.2' || scenario.id === '4.1') {
    if (/form|ticket|escalat/i.test(last) && scenario.id === '4.1') return { grade: 'Minor', note: 'Form too early' };
    if (/which|what kind|clarif|tournament|daily|withdraw/i.test(last)) return { grade: 'Pass', note: 'Clarification before escalation' };
    return { grade: 'Minor', note: last.slice(0, 120) };
  }
  if (scenario.id.startsWith('4.') || scenario.id.startsWith('5.') || scenario.id.startsWith('11.')) {
    if (last === scenario.turns.at(-1)) return { grade: 'Blocked', note: 'No bot reply detected' };
    if (/withdrawal/i.test(last) && /tournament/i.test(scenario.turns[0])) return { grade: 'Fail', note: 'Misclassified as withdrawal' };
    if (/\*\*|```/.test(last)) return { grade: 'Fail', note: 'Markdown artifact' };
    if (/^\s*1\.\s/m.test(last)) return { grade: 'Minor', note: 'Numbered list in plain chat' };
    return { grade: 'Pass', note: last.slice(0, 120) };
  }
  if (scenario.id === '8.1') {
    if (/\*\*|1\. 2\. 3\./.test(last)) return { grade: 'Fail', note: 'Bad formatting' };
    return { grade: 'Pass', note: last.slice(0, 120) };
  }
  if (scenario.id === '9.1') {
    if (/retrieval|faq search|knowledge base|could not find/i.test(last)) return { grade: 'Fail', note: 'Internal retrieval language' };
    return { grade: 'Pass', note: last.slice(0, 120) };
  }
  if (scenario.id === '6.3' || scenario.id === '12.1') {
    if (/ticket id|handoff|agent|team will/i.test(last)) return { grade: 'Pass', note: 'Handoff triggered' };
    if (/form|email|reference/i.test(last)) return { grade: 'Minor', note: 'May need form step' };
    return { grade: 'Minor', note: last.slice(0, 120) };
  }
  if (/retrieval|faq search|knowledge base/i.test(last)) return { grade: 'Fail', note: 'Internal language' };
  return { grade: 'Pass', note: last.slice(0, 120) };
}

async function runScenario(browser, scenario) {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}&player_id=${scenario.pid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await openChat(page);
    const transcript = [];
    for (const turn of scenario.turns) {
      const bot = await sendAndWait(page, turn);
      transcript.push({ user: turn, bot });
    }
    const allBot = transcript.flatMap((t) => t.bot);
    const { grade: g, note } = grade(scenario, allBot);
    return { ...scenario, grade: g, note, lastBot: allBot.at(-1) || '', transcript };
  } catch (err) {
    return { ...scenario, grade: 'Blocked', note: String(err.message || err), lastBot: '', transcript: [] };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const scenario of SCENARIOS) {
  process.stderr.write(`Running ${scenario.id} (player ${scenario.pid})...\n`);
  results.push(await runScenario(browser, scenario));
}
await browser.close();

console.log('| Scenario | player_id | Grade | Bot reply summary | Notes |');
console.log('|---|---:|---|---|---|');
for (const r of results) {
  const summary = (r.lastBot || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 100);
  console.log(`| ${r.id} | ${r.pid} | **${r.grade}** | ${summary} | ${r.note} |`);
}
