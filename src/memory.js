import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = join(__dirname, '..', 'merchant-memory.json');

/** @type {Record<string, { category: string, count: number, lastSeen: string }> | null} */
let memoryCache = null;

/** @param {string} payeeName @returns {string} */
function normalizePayeeKey(payeeName) {
  return String(payeeName ?? '')
    .trim()
    .toLowerCase();
}

/** @returns {string} */
function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reads merchant-memory.json synchronously on startup (or first use).
 * @returns {Record<string, { category: string, count: number, lastSeen: string }>}
 */
export function loadMemory() {
  try {
    if (!existsSync(MEMORY_PATH)) {
      memoryCache = {};
      return memoryCache;
    }
    const raw = readFileSync(MEMORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    memoryCache =
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
        ? parsed
        : {};
    return memoryCache;
  } catch {
    memoryCache = {};
    return memoryCache;
  }
}

/** @returns {Record<string, { category: string, count: number, lastSeen: string }>} */
function getMemory() {
  if (memoryCache === null) {
    loadMemory();
  }
  return /** @type {Record<string, { category: string, count: number, lastSeen: string }>} */ (
    memoryCache
  );
}

/**
 * @param {string} payeeName
 * @returns {{ category: string, count: number, lastSeen: string } | null}
 */
export function lookupMerchant(payeeName) {
  const key = normalizePayeeKey(payeeName);
  if (!key) return null;
  const mem = getMemory();
  const row = mem[key];
  if (!row || typeof row.category !== 'string') return null;
  return {
    category: row.category,
    count: typeof row.count === 'number' ? row.count : 0,
    lastSeen: typeof row.lastSeen === 'string' ? row.lastSeen : '',
  };
}

/**
 * @param {string} payeeName
 * @param {string} categoryName
 * @returns {void}
 */
export function recordCategorization(payeeName, categoryName) {
  try {
    const key = normalizePayeeKey(payeeName);
    const cat = String(categoryName ?? '').trim();
    if (!key || !cat) return;

    const mem = getMemory();
    const today = todayIsoDate();

    if (mem[key]) {
      mem[key].category = cat;
      mem[key].count = (typeof mem[key].count === 'number' ? mem[key].count : 0) + 1;
      mem[key].lastSeen = today;
    } else {
      mem[key] = { category: cat, count: 1, lastSeen: today };
    }

    writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
  } catch (e) {
    console.error(`✗ Merchant memory write failed: ${e.message}`);
  }
}

/**
 * @param {string} payeeName
 * @param {Record<string, { category: string, count: number, lastSeen: string }>} allMemory
 * @param {number} [limit]
 * @returns {{ payee: string, category: string }[]}
 */
export function getTopExamples(payeeName, allMemory, limit = 3) {
  const norm = normalizePayeeKey(payeeName);
  const cap = Math.max(0, limit);
  if (cap === 0) return [];

  const mem =
    allMemory && typeof allMemory === 'object' && !Array.isArray(allMemory)
      ? allMemory
      : {};

  /** @type {{ payee: string, category: string }[]} */
  const out = [];
  const used = new Set();

  if (norm && mem[norm] && mem[norm].category) {
    out.push({ payee: norm, category: mem[norm].category });
    used.add(norm);
  }

  const rest = Object.entries(mem)
    .filter(([k, v]) => !used.has(k) && v && typeof v.category === 'string')
    .sort((a, b) => {
      const ca = typeof a[1].count === 'number' ? a[1].count : 0;
      const cb = typeof b[1].count === 'number' ? b[1].count : 0;
      return cb - ca;
    });

  for (const [k, v] of rest) {
    if (out.length >= cap) break;
    out.push({ payee: k, category: v.category });
  }

  return out;
}

/**
 * @returns {{ totalMerchants: number, totalCategorizations: number }}
 */
export function getMemoryStats() {
  const mem = getMemory();
  const keys = Object.keys(mem);
  let totalCategorizations = 0;
  for (const k of keys) {
    const c = mem[k]?.count;
    totalCategorizations += typeof c === 'number' ? c : 0;
  }
  return {
    totalMerchants: keys.length,
    totalCategorizations,
  };
}
