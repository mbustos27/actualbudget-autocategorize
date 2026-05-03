import dotenv from 'dotenv';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const required = [
  'ACTUAL_SERVER_URL',
  'ACTUAL_PASSWORD',
  'ACTUAL_BUDGET_ID',
  'ACTUAL_DATA_DIR',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
];

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill in values.`,
    );
  }
  return String(v).trim();
}

for (const key of required) {
  requireEnv(key);
}

const ACTUAL_DATA_DIR = resolve(projectRoot, requireEnv('ACTUAL_DATA_DIR'));

try {
  mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
} catch (e) {
  throw new Error(`Could not create ACTUAL_DATA_DIR (${ACTUAL_DATA_DIR}): ${e.message}`);
}

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return defaultValue;
}

function parseRefineTargets() {
  const raw = process.env.REFINE_FROM_CATEGORY_NAMES;
  const parts = (raw && raw.trim()
    ? raw
    : 'General'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : ['general'];
}

export const config = {
  ACTUAL_SERVER_URL: requireEnv('ACTUAL_SERVER_URL').replace(/\/+$/, ''),
  ACTUAL_PASSWORD: requireEnv('ACTUAL_PASSWORD'),
  ACTUAL_BUDGET_ID: requireEnv('ACTUAL_BUDGET_ID'),
  ACTUAL_DATA_DIR,
  OLLAMA_URL: requireEnv('OLLAMA_URL').replace(/\/+$/, ''),
  OLLAMA_MODEL: requireEnv('OLLAMA_MODEL'),
  DRY_RUN: boolEnv('DRY_RUN', false),
  /** When true, create a category if the model suggests a name not already in the budget. */
  AUTO_CREATE_CATEGORIES: boolEnv('AUTO_CREATE_CATEGORIES', true),
  /** Optional: UUID of the category *group* where new expense categories are created. */
  ACTUAL_NEW_CATEGORY_GROUP_ID: process.env.ACTUAL_NEW_CATEGORY_GROUP_ID?.trim() || '',
  /** Optional: name of category group (e.g. "Flexible") if ACTUAL_NEW_CATEGORY_GROUP_ID is unset. */
  ACTUAL_NEW_CATEGORY_GROUP_NAME: process.env.ACTUAL_NEW_CATEGORY_GROUP_NAME?.trim() || '',
  /** Only process txs whose current category name is in this list (comma-separated). Default targets broad buckets like General. */
  REFINE_FROM_CATEGORY_NAMES: parseRefineTargets(),
  /** When true, only re-categorize transactions already in a refine-target category. */
  REFINE_MODE: boolEnv('REFINE_MODE', false),
  /** When true, run uncategorized pass then refine pass in one invocation (requires REFINE targets in budget). */
  DOUBLE_RUN: boolEnv('DOUBLE_RUN', false),
  /** After consolidation remap, allow deleting empty source categories (respects DRY_RUN). */
  AUTO_DELETE_EMPTY_CATEGORIES: boolEnv('AUTO_DELETE_EMPTY_CATEGORIES', false),
};

/** Same as `config.AUTO_DELETE_EMPTY_CATEGORIES`. */
export const AUTO_DELETE_EMPTY_CATEGORIES = config.AUTO_DELETE_EMPTY_CATEGORIES;
