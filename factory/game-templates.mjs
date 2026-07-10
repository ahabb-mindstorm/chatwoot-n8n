import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROGOLF_CATEGORIES,
  PROGOLF_REWARD_SOURCES,
  buildProgolfBotConfig,
} from '../workflows/progolf-escalation-template.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_TEMPLATE_PATH = join(repoRoot, 'workflows', 'progolf-support-bot-v2-pgvector.json');

let cachedProgolfSystemMessage;

function loadProgolfSystemMessage() {
  if (cachedProgolfSystemMessage !== undefined) {
    return cachedProgolfSystemMessage;
  }

  const workflow = JSON.parse(readFileSync(MAIN_TEMPLATE_PATH, 'utf8'));
  const supportAgent = workflow.nodes.find((node) => node.name === 'Support Agent');
  cachedProgolfSystemMessage =
    supportAgent?.parameters?.options?.systemMessage?.trim() || null;
  return cachedProgolfSystemMessage;
}

const GAME_TEMPLATES = {
  progolf: {
    gameId: 'progolf',
    templateId: 'progolf-support-bot-v2-pgvector',
    name: 'Pro Golf Support Bot',
    description: 'AI support agent for Pro Golf: Real Cash',
    taxonomy: {
      categories: [...PROGOLF_CATEGORIES],
      rewardSources: [...PROGOLF_REWARD_SOURCES],
    },
    get systemMessage() {
      return loadProgolfSystemMessage();
    },
    get botConfig() {
      return buildProgolfBotConfig();
    },
  },
};

export function listGameTemplateIds() {
  return Object.keys(GAME_TEMPLATES).sort();
}

export function getGameTemplate(gameId) {
  const template = getGameTemplateOrNull(gameId);
  if (!template) {
    const error = new Error(`No bot template found for gameId "${gameId}"`);
    error.name = 'GameTemplateNotFoundError';
    throw error;
  }
  return template;
}

export function getGameTemplateOrNull(gameId) {
  const template = GAME_TEMPLATES[String(gameId || '').trim().toLowerCase()];
  return template ? serializeGameTemplate(template) : null;
}

export function resolveProvisionTaxonomy(spec) {
  const configTaxonomy =
    spec.botConfig &&
    typeof spec.botConfig === 'object' &&
    !Array.isArray(spec.botConfig) &&
    spec.botConfig.taxonomy &&
    typeof spec.botConfig.taxonomy === 'object' &&
    !Array.isArray(spec.botConfig.taxonomy)
      ? spec.botConfig.taxonomy
      : null;

  const categories = sanitizeTaxonomyList(configTaxonomy?.categories);
  const rewardSources = sanitizeTaxonomyList(configTaxonomy?.rewardSources);

  if (!categories.length && !rewardSources.length) {
    return null;
  }

  return { categories, rewardSources };
}

function serializeGameTemplate(template) {
  return {
    gameId: template.gameId,
    templateId: template.templateId,
    name: template.name,
    description: template.description,
    taxonomy: {
      categories: [...template.taxonomy.categories],
      rewardSources: [...template.taxonomy.rewardSources],
    },
    systemMessage: template.systemMessage,
    botConfig: JSON.parse(JSON.stringify(template.botConfig)),
  };
}

function sanitizeTaxonomyList(primary) {
  const source = Array.isArray(primary) ? primary : [];
  return source
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}
