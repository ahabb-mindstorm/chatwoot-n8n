#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

N8N_DB_NAME="${N8N_DB_NAME:-n8n}"
N8N_WORKER_REPLICAS="${N8N_WORKER_REPLICAS:-2}"
MIGRATE_N8N_INCLUDE_EXECUTIONS="${MIGRATE_N8N_INCLUDE_EXECUTIONS:-false}"
MIGRATE_N8N_DROP_EXISTING_TARGET_DB="${MIGRATE_N8N_DROP_EXISTING_TARGET_DB:-false}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "${1:-}" == "--apply" || "${1:-}" == "--preflight" || -z "${1:-}" ]] || \
  fail "Usage: $0 [--preflight|--apply]"
[[ "$N8N_DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "N8N_DB_NAME must be a safe PostgreSQL identifier"
[[ "$N8N_WORKER_REPLICAS" =~ ^[1-9][0-9]*$ ]] || fail "N8N_WORKER_REPLICAS must be a positive integer"
[[ -n "${N8N_ENCRYPTION_KEY:-}" ]] || fail "Set N8N_ENCRYPTION_KEY in .env to the existing n8n encryption key"
[[ -n "${REDIS_PASSWORD:-}" ]] || fail "Set a strong REDIS_PASSWORD in .env"

docker compose version >/dev/null
docker compose ps --status running n8n | grep -q n8n || fail "The current SQLite-backed n8n container must be running for preflight"

current_key="$({
  docker compose exec -T n8n node -e \
    "const fs=require('fs'); const p='/home/node/.n8n/config'; const c=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(c.encryptionKey || process.env.N8N_ENCRYPTION_KEY || '');"
} 2>/dev/null)"
[[ -n "$current_key" ]] || fail "Could not read the current n8n encryption key"
[[ "$current_key" == "$N8N_ENCRYPTION_KEY" ]] || fail "N8N_ENCRYPTION_KEY does not match the current instance; migration would make credentials unreadable"

N8N_ENCRYPTION_KEY="$N8N_ENCRYPTION_KEY" REDIS_PASSWORD="$REDIS_PASSWORD" \
  docker compose -f docker-compose.queue.yml config --quiet

echo "Preflight passed: current n8n uses the expected encryption key."
echo "Target: PostgreSQL database '$N8N_DB_NAME', Redis queue, $N8N_WORKER_REPLICAS workers."

if [[ "${1:-}" != "--apply" ]]; then
  echo "No changes made. Run $0 --apply during a maintenance window."
  exit 0
fi

if docker compose exec -T postgres psql -U "${POSTGRES_USER:-chatwoot_bot}" -d "${POSTGRES_DB:-chatwoot_bot}" -Atqc \
  "SELECT 1 FROM pg_database WHERE datname = '$N8N_DB_NAME'" | grep -q 1; then
  if [[ "$MIGRATE_N8N_DROP_EXISTING_TARGET_DB" == "true" ]]; then
    echo "Dropping existing target database '$N8N_DB_NAME' because MIGRATE_N8N_DROP_EXISTING_TARGET_DB=true..."
    docker compose exec -T postgres dropdb --if-exists \
      -U "${POSTGRES_USER:-chatwoot_bot}" \
      "$N8N_DB_NAME"
  else
    fail "Database '$N8N_DB_NAME' already exists. Refusing to overwrite it. If this is a failed partial migration, rerun once with MIGRATE_N8N_DROP_EXISTING_TARGET_DB=true."
  fi
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$PWD/backups/n8n-queue-$timestamp"
mkdir -p "$backup_dir/entities"
chmod 700 "$backup_dir"

legacy_stopped=false
queue_started=false
target_db_created=false
rollback_on_error() {
  if [[ "$queue_started" == false && "$target_db_created" == true ]]; then
    echo "Migration failed; dropping the partially imported target database '$N8N_DB_NAME'." >&2
    docker compose exec -T postgres dropdb --if-exists \
      -U "${POSTGRES_USER:-chatwoot_bot}" \
      "$N8N_DB_NAME" || true
  fi
  if [[ "$queue_started" == false && "$legacy_stopped" == true ]]; then
    echo "Migration failed; restarting the untouched SQLite n8n service." >&2
    docker compose up -d n8n || true
  fi
}
trap rollback_on_error ERR

echo "Stopping n8n for a consistent export..."
docker compose stop n8n
legacy_stopped=true

echo "Backing up the n8n data volume..."
n8n_container_id="$(docker compose ps -a -q n8n)"
[[ -n "$n8n_container_id" ]] || fail "Could not find the stopped n8n container for volume backup"
docker run --rm --volumes-from "$n8n_container_id" -v "$backup_dir:/backup" alpine:3.20 \
  tar -czf /backup/n8n-data.tgz -C /home/node/.n8n .

export_args=(export:entities --outputDir=/backup/entities)
if [[ "$MIGRATE_N8N_INCLUDE_EXECUTIONS" == "true" ]]; then
  export_args+=(--includeExecutionHistoryDataTables=true)
  echo "Exporting all n8n entities, including execution history..."
else
  echo "Exporting n8n entities without historical execution rows..."
fi
docker compose run --rm --no-deps -v "$backup_dir:/backup" n8n \
  "${export_args[@]}"

echo "Creating the dedicated n8n PostgreSQL database..."
docker compose exec -T postgres createdb \
  -U "${POSTGRES_USER:-chatwoot_bot}" \
  -O "${POSTGRES_USER:-chatwoot_bot}" \
  "$N8N_DB_NAME"
target_db_created=true

echo "Starting PostgreSQL and Redis for the import..."
docker compose -f docker-compose.queue.yml up -d postgres redis

echo "Importing n8n entities into PostgreSQL..."
docker compose -f docker-compose.queue.yml run --rm --no-deps -v "$backup_dir:/backup" n8n \
  import:entities --inputDir=/backup/entities --truncateTables=true

echo "Starting n8n queue mode with $N8N_WORKER_REPLICAS workers..."
docker compose -f docker-compose.queue.yml up -d --scale n8n-worker="$N8N_WORKER_REPLICAS" n8n n8n-worker
queue_started=true
trap - ERR

echo "Waiting for the main n8n health endpoint..."
for _ in $(seq 1 30); do
  if docker compose -f docker-compose.queue.yml exec -T n8n \
    wget -q -O- http://localhost:5678/healthz >/dev/null 2>&1; then
    echo "Queue-mode n8n is healthy. Backup: $backup_dir"
    echo "Rollback: docker compose -f docker-compose.queue.yml down && docker compose up -d n8n"
    exit 0
  fi
  sleep 2
done

fail "Queue services started but n8n did not become healthy; inspect docker compose -f docker-compose.queue.yml logs"
