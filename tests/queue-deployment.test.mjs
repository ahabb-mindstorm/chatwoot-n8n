import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(join(root, "docker-compose.queue.yml"), "utf8");
const migration = readFileSync(join(root, "scripts/migrate-n8n-to-queue.sh"), "utf8");

test("queue deployment uses Redis, PostgreSQL, and separate workers", () => {
  assert.match(compose, /EXECUTIONS_MODE:\s*queue/);
  assert.match(compose, /DB_TYPE:\s*postgresdb/);
  assert.match(compose, /N8N_SECURE_COOKIE:\s*\$\{N8N_SECURE_COOKIE:-false\}/);
  assert.match(compose, /QUEUE_BULL_REDIS_HOST:\s*redis/);
  assert.match(compose, /redis:\n[\s\S]*redis:7-alpine/);
  assert.match(compose, /n8n-worker:\n[\s\S]*command:\s*\["worker"/);
  assert.match(compose, /n8n:\n[\s\S]*networks:\n\s+- default\n\s+- chatwoot_default/);
  assert.match(compose, /n8n-worker:\n[\s\S]*networks:\n\s+- default\n\s+- chatwoot_default/);
  assert.match(compose, /chatwoot_default:\n\s+external:\s+true/);
  assert.doesNotMatch(compose.slice(compose.indexOf("  redis:"), compose.indexOf("  n8n:")), /ports:/);
  assert.doesNotMatch(compose.slice(compose.indexOf("  n8n-worker:"), compose.indexOf("\nvolumes:")), /n8n_data/);
});

test("hung executions stop before the durable conversation lease expires", () => {
  const timeout = Number(compose.match(/EXECUTIONS_TIMEOUT:\s*\$\{N8N_EXECUTIONS_TIMEOUT:-(\d+)\}/)?.[1]);
  const lease = Number(compose.match(/CONVERSATION_LEASE_SECONDS:\s*\$\{CONVERSATION_LEASE_SECONDS:-(\d+)\}/)?.[1]);
  const aiTimeoutMs = Number(compose.match(/N8N_AI_TIMEOUT_MAX:\s*\$\{N8N_AI_TIMEOUT_MAX_MS:-(\d+)\}/)?.[1]);
  assert.ok(timeout > 0 && timeout < lease);
  assert.ok(aiTimeoutMs > 0 && aiTimeoutMs / 1000 < timeout);
  assert.match(compose, /QUEUE_WORKER_MAX_STALLED_COUNT:\s*1/);
});

test("queue migration protects credentials and leaves a rollback path", () => {
  assert.match(migration, /N8N_ENCRYPTION_KEY does not match the current instance/);
  assert.match(migration, /export:entities/);
  assert.match(migration, /MIGRATE_N8N_INCLUDE_EXECUTIONS/);
  assert.match(migration, /Exporting n8n entities without historical execution rows/);
  assert.match(migration, /--includeExecutionHistoryDataTables=true/);
  assert.match(migration, /import:entities/);
  assert.match(migration, /docker compose ps -a -q n8n/);
  assert.match(migration, /docker run --rm --volumes-from "\$n8n_container_id"/);
  assert.doesNotMatch(migration, /docker compose run --rm --no-deps -v "\$backup_dir:\/backup" n8n \\\n\s+sh -c/);
  assert.match(migration, /Refusing to overwrite it/);
  assert.match(migration, /MIGRATE_N8N_DROP_EXISTING_TARGET_DB=true/);
  assert.match(migration, /dropping the partially imported target database/);
  assert.match(migration, /restarting the untouched SQLite n8n service/);
  assert.match(migration, /--scale n8n-worker=/);
});
