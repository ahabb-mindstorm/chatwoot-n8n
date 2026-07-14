import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_REVISION,
  buildSharedSupportRuntimeArtifact,
} from '../factory/support-runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(
  root,
  'factory',
  'artifacts',
  'helio-support-runtime.json',
);
const outputPath = join(
  root,
  'factory',
  'artifacts',
  'helio-support-runtime.json',
);
const registryPath = join(
  root,
  'factory',
  'artifacts',
  'runtime-revisions.json',
);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const artifact = buildSharedSupportRuntimeArtifact(source, {
  revision: RUNTIME_REVISION,
  webhookBaseUrl: 'http://n8n:5678',
});

mkdirSync(dirname(outputPath), { recursive: true });
const artifactSource = `${JSON.stringify(artifact, null, 2)}\n`;
const digest = crypto.createHash('sha256').update(artifactSource).digest('hex');
let registry = {};
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch {
  registry = {};
}
if (registry[RUNTIME_REVISION] && registry[RUNTIME_REVISION] !== digest) {
  throw new Error(
    `Runtime revision ${RUNTIME_REVISION} is immutable; bump RUNTIME_REVISION before changing it`,
  );
}
registry[RUNTIME_REVISION] = digest;
writeFileSync(outputPath, artifactSource);
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(
  JSON.stringify({
    outputPath,
    runtimeRevision: RUNTIME_REVISION,
    nodes: artifact.nodes.length,
    digest,
  }),
);
