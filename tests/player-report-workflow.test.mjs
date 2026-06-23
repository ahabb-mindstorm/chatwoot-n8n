import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

function loadWorkflow() {
  const raw = readFileSync(
    join(rootDir, "workflows/progolf-support-bot-v2-pgvector.json"),
    "utf8",
  );
  return JSON.parse(raw);
}

async function runNormalizeLookup(workflow, extractEvent, agentOutput) {
  const node = workflow.nodes.find((candidate) => candidate.name === "Normalize Escalation Lookup");
  assert.ok(node, "Normalize Escalation Lookup node exists");
  const code = node.parameters?.jsCode;
  assert.ok(code, "Normalize Escalation Lookup has jsCode");

  const context = {
    $input: {
      first: () => ({ json: { output: agentOutput } }),
    },
    $(name) {
      if (name === "Extract Event") {
        return { first: () => ({ json: extractEvent }) };
      }
      return { first: () => ({ json: {} }) };
    },
  };

  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  const [result] = await script.runInContext(vm.createContext(context));
  return result.json;
}

test("normalize remaps cheating tournament report from gameplay_tournament to player_report", async () => {
  const workflow = loadWorkflow();
  const result = await runNormalizeLookup(
    workflow,
    { content: "in FELIX_CUP_413413515, there is a cheater" },
    {
      category: "gameplay_tournament",
      reward_source: "",
      reply: "",
      summary: "Player reports cheating in tournament FELIX_CUP_413413515",
    },
  );

  assert.equal(result.output.category, "player_report");
});

test("normalize remaps cheating report from other to player_report", async () => {
  const workflow = loadWorkflow();
  const result = await runNormalizeLookup(
    workflow,
    { content: "someone is harassing me in chat" },
    {
      category: "other",
      reward_source: "",
      reply: "",
      summary: "Player reports harassment",
    },
  );

  assert.equal(result.output.category, "player_report");
});

test("normalize preserves explicit player_report category", async () => {
  const workflow = loadWorkflow();
  const result = await runNormalizeLookup(
    workflow,
    { content: "I want to report a player for cheating" },
    {
      category: "player_report",
      reward_source: "",
      reply: "",
      summary: "Player report",
    },
  );

  assert.equal(result.output.category, "player_report");
});

test("normalize does not remap tournament reward issues to player_report", async () => {
  const workflow = loadWorkflow();
  const result = await runNormalizeLookup(
    workflow,
    { content: "I didn't get my tournament cash from last tournament" },
    {
      category: "reward",
      reward_source: "tournament",
      reply: "",
      summary: "Missing tournament reward",
    },
  );

  assert.equal(result.output.category, "reward");
  assert.equal(result.output.reward_source, "tournament");
});

test("get escalation requirements sdk includes player_report template", () => {
  const sdk = readFileSync(
    join(rootDir, "workflows/get-escalation-requirements.sdk.js"),
    "utf8",
  );
  assert.match(sdk, /player_report/);
  assert.match(sdk, /Describe what the other player did/);
  assert.match(sdk, /validCategories.*player_report/);
});
