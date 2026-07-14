import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escalationResolverNodeJsCode,
  escalationToolNodeParameters,
} from '../workflows/escalation-resolver.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = process.argv[2] || join(root, 'workflows/progolf-support-bot-v2-pgvector.json');
const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));

const loadNode = workflow.nodes.find((node) => node.name === 'Load Canonical Escalation Requirements');
if (!loadNode) {
  throw new Error('Load Canonical Escalation Requirements node not found');
}
loadNode.type = 'n8n-nodes-base.code';
loadNode.typeVersion = 2;
delete loadNode.credentials;
loadNode.parameters = {
  mode: 'runOnceForEachItem',
  jsCode: escalationResolverNodeJsCode(),
};

const toolNode = workflow.nodes.find((node) => node.name === 'Get Escalation Requirements');
if (!toolNode) {
  throw new Error('Get Escalation Requirements node not found');
}
toolNode.type = '@n8n/n8n-nodes-langchain.toolCode';
toolNode.typeVersion = 1.2;
delete toolNode.credentials;
toolNode.parameters = escalationToolNodeParameters();

writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Patched escalation resolver nodes in ${workflowPath}`);
