import pg from 'pg';

const { Pool } = pg;

export class RuntimePersistenceError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'RuntimePersistenceError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function createRuntimePersistenceFromEnv(env = process.env) {
  const connectionString = String(env.BOT_DATABASE_URL || '').trim();
  const pool = new Pool(
    connectionString
      ? {
          connectionString,
          ssl: parseSsl(env.BOT_DB_SSL),
        }
      : {
          host: env.BOT_DB_HOST || 'postgres',
          port: Number(env.BOT_DB_PORT || 5432),
          database: env.BOT_DB_NAME || env.POSTGRES_DB || 'chatwoot_bot',
          user: env.BOT_DB_USER || env.POSTGRES_USER || 'chatwoot_bot',
          password: env.BOT_DB_PASSWORD || env.POSTGRES_PASSWORD,
          ssl: parseSsl(env.BOT_DB_SSL),
        },
  );
  return createPostgresRuntimePersistence(pool);
}

export function createPostgresRuntimePersistence(pool) {
  if (typeof pool?.query !== 'function') {
    throw new TypeError('Runtime persistence requires a Postgres pool');
  }

  return {
    async findByDeliveryId(scope) {
      const normalized = validateScope(scope);
      const result = await pool.query(
        `SELECT receipt
           FROM bot_support_turns
          WHERE account_id = $1
            AND agent_bot_id = $2
            AND conversation_id = $3
            AND delivery_id = $4
          LIMIT 1`,
        [
          normalized.accountId,
          normalized.agentBotId,
          normalized.conversationId,
          normalized.deliveryId,
        ],
      );
      return result.rows[0]?.receipt || null;
    },

    async commitTurn(accountIdInput, turnInput) {
      const accountId = positiveInteger(accountIdInput, 'accountId');
      const turn = validateTurn(turnInput);
      try {
        const result = await pool.query(
          `SELECT bot_commit_support_turn(
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11
           ) AS result`,
          [
            accountId,
            turn.conversationId,
            turn.agentBotId,
            turn.deliveryId,
            turn.expectedStateVersion,
            turn.outcome,
            JSON.stringify(turn.nextState),
            JSON.stringify(turn.effects),
            turn.runtimeRevision,
            turn.policyVersion,
            turn.failureCode || null,
          ],
        );
        const value = parseObject(result.rows[0]?.result);
        if (!value.receipt) {
          throw new RuntimePersistenceError(
            503,
            'Runtime turn commit returned no receipt',
          );
        }
        return {
          duplicate: value.duplicate === true,
          receipt: value.receipt,
        };
      } catch (error) {
        if (error instanceof RuntimePersistenceError) throw error;
        if (error?.code === '40001') {
          throw new RuntimePersistenceError(409, 'Ticket state version conflict', {
            code: 'ticket_state_conflict',
          });
        }
        throw error;
      }
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

function validateScope(scope) {
  return {
    accountId: positiveInteger(scope?.accountId, 'accountId'),
    agentBotId: positiveInteger(scope?.agentBotId, 'agentBotId'),
    conversationId: positiveInteger(scope?.conversationId, 'conversationId'),
    deliveryId: requiredString(scope?.deliveryId, 'deliveryId'),
  };
}

function validateTurn(turn) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
    throw new RuntimePersistenceError(400, 'Runtime turn is required');
  }
  const expectedStateVersion = Number(turn.expectedStateVersion);
  if (!Number.isInteger(expectedStateVersion) || expectedStateVersion < 0) {
    throw new RuntimePersistenceError(
      400,
      'expectedStateVersion must be a non-negative integer',
    );
  }
  if (!turn.nextState || typeof turn.nextState !== 'object' || Array.isArray(turn.nextState)) {
    throw new RuntimePersistenceError(400, 'nextState must be an object');
  }
  if (!Array.isArray(turn.effects)) {
    throw new RuntimePersistenceError(400, 'effects must be an array');
  }
  return {
    agentBotId: positiveInteger(turn.agentBotId, 'agentBotId'),
    conversationId: positiveInteger(turn.conversationId, 'conversationId'),
    deliveryId: requiredString(turn.deliveryId, 'deliveryId'),
    expectedStateVersion,
    outcome: requiredString(turn.outcome, 'outcome'),
    nextState: turn.nextState,
    effects: turn.effects,
    runtimeRevision: requiredString(turn.runtimeRevision, 'runtimeRevision'),
    policyVersion: Number(turn.policyVersion),
    failureCode: String(turn.failureCode || '').trim(),
  };
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RuntimePersistenceError(400, `${field} must be a positive integer`);
  }
  return number;
}

function requiredString(value, field) {
  const text = String(value || '').trim();
  if (!text) {
    throw new RuntimePersistenceError(400, `${field} is required`);
  }
  return text;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseSsl(value) {
  return /^(1|true|yes)$/i.test(String(value || ''))
    ? { rejectUnauthorized: false }
    : false;
}
