#!/usr/bin/env node
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  FactoryError,
  authenticateFactoryRequest,
  deprovisionBotWorkflows,
  ensureSharedFaqSyncWorkflow,
  ensureSharedSupportRuntime,
  provisionBotWorkflows,
} from './bot-factory.mjs';
import { getGameTemplate, listGameTemplateIds } from './game-templates.mjs';
import {
  RuntimePersistenceError,
  createRuntimePersistenceFromEnv,
} from './runtime-persistence.mjs';

const PORT = Number(process.env.BOT_FACTORY_PORT || 3020);
const MAX_BODY_BYTES = 1024 * 1024;

export function createFactoryServer(options = {}) {
  let runtimePersistence = options.runtimePersistence || null;
  const getRuntimePersistence = () => {
    if (!runtimePersistence) {
      runtimePersistence = createRuntimePersistenceFromEnv(options.env || process.env);
    }
    return runtimePersistence;
  };

  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === 'GET' && request.url === '/games') {
        authenticateFactoryRequest(request.headers, process.env.BOT_FACTORY_API_SECRET);
        return sendJson(response, 200, { games: listGameTemplateIds() });
      }

      const templateMatch = request.method === 'GET'
        ? /^\/games\/([^/]+)\/template$/.exec(request.url || '')
        : null;
      if (templateMatch) {
        authenticateFactoryRequest(request.headers, process.env.BOT_FACTORY_API_SECRET);
        try {
          const template = getGameTemplate(decodeURIComponent(templateMatch[1]));
          return sendJson(response, 200, template);
        } catch (error) {
          if (error?.name === 'GameTemplateNotFoundError') {
            return sendJson(response, 404, { error: error.message });
          }
          throw error;
        }
      }

      if (request.method !== 'POST') {
        return sendJson(response, 404, { error: 'Not found' });
      }

      authenticateFactoryRequest(request.headers, process.env.BOT_FACTORY_API_SECRET);
      const body = await readJsonBody(request);

      if (request.url === '/runtime/turns/find') {
        const receipt = await getRuntimePersistence().findByDeliveryId(body);
        return sendJson(response, 200, { receipt });
      }

      if (request.url === '/runtime/turns/commit') {
        const result = await getRuntimePersistence().commitTurn(
          body.accountId,
          body.turn,
        );
        return sendJson(response, 200, result);
      }

      if (request.url === '/deprovision-bot') {
        const result = await deprovisionBotWorkflows(body);
        return sendJson(response, 200, result);
      }

      if (['/provision-bot', '/provision'].includes(request.url || '')) {
        const result = await provisionBotWorkflows(body);
        return sendJson(response, 201, result);
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return sendError(response, error);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createFactoryServer().listen(PORT, '0.0.0.0', async () => {
    console.log(`Helio Bot Factory listening on 0.0.0.0:${PORT}`);
    try {
      const sharedFaqSync = await ensureSharedFaqSyncWorkflow();
      console.log(
        `Shared FAQ sync workflow ready at ${sharedFaqSync.webhookUrl} (id=${sharedFaqSync.workflowId})`,
      );
    } catch (error) {
      console.error('Failed to ensure shared FAQ sync workflow on startup', error);
    }
    try {
      const sharedRuntime = await ensureSharedSupportRuntime();
      console.log(
        `Shared support runtime ready at ${sharedRuntime.webhookUrl} (id=${sharedRuntime.workflowId}, revision=${sharedRuntime.runtimeRevision})`,
      );
    } catch (error) {
      console.error('Failed to ensure shared support runtime on startup', error);
    }
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new FactoryError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('error', reject);
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new FactoryError(400, 'Request body is required'));
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new FactoryError(400, 'Request body must be valid JSON'));
      }
    });
  });
}

function sendError(response, error) {
  if (error instanceof FactoryError || error instanceof RuntimePersistenceError) {
    return sendJson(response, error.statusCode, {
      error: error.message,
      details: error.details,
    });
  }

  console.error(error);
  return sendJson(response, 500, { error: 'Bot Factory failed' });
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
