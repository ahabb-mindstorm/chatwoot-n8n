import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_REVISION,
  buildSharedSupportRuntimeArtifact,
} from '../factory/support-runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(
  root,
  'workflows',
  'progolf-support-bot-v2-pgvector.json',
);
const outputPath = join(
  root,
  'factory',
  'artifacts',
  'helio-support-runtime.json',
);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const artifact = buildSharedSupportRuntimeArtifact(source, {
  revision: RUNTIME_REVISION,
  webhookBaseUrl: 'http://n8n:5678',
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  JSON.stringify({
    outputPath,
    runtimeRevision: RUNTIME_REVISION,
    nodes: artifact.nodes.length,
  }),
);
