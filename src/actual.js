import * as api from '@actual-app/api';
import { config } from './config.js';

let connected = false;

function formatBudgetError(e) {
  const msg =
    e?.message ??
    (typeof e === 'string' ? e : JSON.stringify(e, null, 0)) ??
    String(e);
  if (msg.includes('out-of-sync') || msg.includes('migrations')) {
    return [
      'Local budget cache does not match this @actual-app/api version (schema / migrations).',
      'Fix: (1) npm install @actual-app/api@latest  (2) Delete the local cache folder, then run again:',
      `    Remove-Item -Recurse -Force "${config.ACTUAL_DATA_DIR}"`,
      '    (PowerShell from project folder — this re-downloads your budget from the server.)',
      `Underlying: ${msg}`,
    ].join('\n');
  }
  return msg;
}

function findCategoryByName(categories, name) {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  return categories.find((c) => c.name.toLowerCase() === target) ?? null;
}

function findFallbackCategory(categories) {
  const prefer = ['uncategorized', 'other'];
  for (const p of prefer) {
    const found = categories.find((c) => c.name.toLowerCase() === p);
    if (found) return found;
  }
  return categories[0] ?? null;
}

/** @param {string} raw */
export function sanitizeNewCategoryName(raw) {
  let s = String(raw).trim().replace(/\s+/g, ' ');
  s = s.replace(/[\r\n\x00-\x1f]/g, '');
  if (s.length > 100) s = s.slice(0, 100).trim();
  return s;
}

let cachedGroups = null;

async function loadCategoryGroups() {
  if (cachedGroups) return cachedGroups;
  cachedGroups = await api.getCategoryGroups();
  return cachedGroups;
}

/**
 * Pick group for a new category: explicit env id, or name match, else income vs expense from amount.
 */
async function pickGroupIdForNewCategory(transaction) {
  const groups = await loadCategoryGroups();
  if (!groups?.length) {
    throw new Error('No category groups in budget (cannot create category).');
  }

  if (config.ACTUAL_NEW_CATEGORY_GROUP_ID) {
    const ok = groups.some((g) => g.id === config.ACTUAL_NEW_CATEGORY_GROUP_ID);
    if (ok) return config.ACTUAL_NEW_CATEGORY_GROUP_ID;
  }

  if (config.ACTUAL_NEW_CATEGORY_GROUP_NAME) {
    const want = config.ACTUAL_NEW_CATEGORY_GROUP_NAME.toLowerCase();
    const g = groups.find((x) => x.name?.toLowerCase() === want);
    if (g) return g.id;
  }

  const isIncomeGroup = (g) =>
    g.is_income === true || g.isIncome === true;
  const incomeGroup = groups.find(isIncomeGroup);
  const expenseGroup = groups.find((g) => !isIncomeGroup(g));
  const useIncome = transaction.amount > 0 && incomeGroup != null;

  if (useIncome) return incomeGroup.id;
  if (expenseGroup) return expenseGroup.id;
  return groups[0].id;
}

/**
 * Match an LLM-suggested name to an existing category, optionally create one.
 * Mutates `categories` when a category is created so later txs see it.
 *
 * @param {string} suggestedName
 * @param {object} transaction
 * @param {{ id: string, name: string }[]} categories
 * @returns {Promise<{ id: string | null, name: string, created: boolean }>}
 */
export async function matchOrCreateCategory(suggestedName, transaction, categories) {
  const cleaned = sanitizeNewCategoryName(suggestedName);
  if (!cleaned) {
    const fb = findFallbackCategory(categories);
    return { id: fb?.id ?? null, name: fb?.name ?? 'Uncategorized', created: false };
  }

  const existing = findCategoryByName(categories, cleaned);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }

  if (!config.AUTO_CREATE_CATEGORIES) {
    const fb = findFallbackCategory(categories);
    return { id: fb?.id ?? null, name: fb?.name ?? cleaned, created: false };
  }

  if (config.DRY_RUN) {
    return { id: null, name: cleaned, created: true };
  }

  const groupId = await pickGroupIdForNewCategory(transaction);
  const isIncome = transaction.amount > 0;

  try {
    const newId = await api.createCategory({
      name: cleaned,
      group_id: groupId,
      ...(isIncome ? { is_income: true } : {}),
    });

    const row = { id: newId, name: cleaned };
    categories.push(row);
    return { id: newId, name: cleaned, created: true };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/unique|already exists|duplicate/i.test(msg)) {
      await refreshCategoriesFromServer(categories);
      const again = findCategoryByName(categories, cleaned);
      if (again) return { id: again.id, name: again.name, created: false };
    }
    throw e;
  }
}

async function refreshCategoriesFromServer(categories) {
  const raw = await api.getCategories();
  const list = Array.isArray(raw) ? raw : [];
  categories.length = 0;
  for (const c of list) {
    categories.push({ id: c.id, name: c.name });
  }
}

/** Reload category id/name list from the open budget (e.g. between double-run phases). */
export async function reloadCategoriesFromBudget(categories) {
  await refreshCategoriesFromServer(categories);
}

export function categoryNameById(categories, categoryId) {
  if (categoryId == null || categoryId === '') return '';
  const c = categories.find((x) => x.id === categoryId);
  return c?.name ?? '';
}

/**
 * Transactions currently assigned to a "broad" category (for refine pass).
 */
export async function getRefinableTransactions(accountId, categories, broadNamesLower) {
  const broad = new Set(broadNamesLower);
  const broadIds = new Set(
    categories
      .filter((c) => broad.has(String(c.name).toLowerCase()))
      .map((c) => c.id),
  );
  if (broadIds.size === 0) return [];

  const txs = await api.getTransactions(accountId, '2000-01-01', '2099-12-31');
  return txs.filter((t) => t.category && broadIds.has(t.category));
}

export async function connect() {
  try {
    await api.init({
      dataDir: config.ACTUAL_DATA_DIR,
      serverURL: config.ACTUAL_SERVER_URL,
      password: config.ACTUAL_PASSWORD,
    });
  } catch (e) {
    throw new Error(
      `Actual Budget connection failed (server: ${config.ACTUAL_SERVER_URL}). Check URL, password, and network. ${e.message}`,
    );
  }

  try {
    await api.downloadBudget(config.ACTUAL_BUDGET_ID);
  } catch (e) {
    try {
      await api.shutdown();
    } catch {
      // ignore
    }
    connected = false;
    const hint = formatBudgetError(e);
    throw new Error(
      hint.includes('Local budget cache')
        ? hint
        : `Could not download budget (sync id: ${config.ACTUAL_BUDGET_ID}). Check ACTUAL_BUDGET_ID in Settings → Advanced → Sync ID.\n${hint}`,
    );
  }

  connected = true;
  cachedGroups = null;

  const accounts = await api.getAccounts();
  const rawCategories = await api.getCategories();
  const list = Array.isArray(rawCategories) ? rawCategories : [];
  const categories = list.map((c) => ({ id: c.id, name: c.name }));

  const payees = await api.getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));

  return { accounts, categories, payeeById };
}

/**
 * @param {string} accountId
 */
export async function getUncategorizedTransactions(accountId) {
  const txs = await api.getTransactions(accountId, '2000-01-01', '2099-12-31');
  return txs.filter((t) => t.category == null || t.category === '');
}

/**
 * @param {string} transactionId
 * @param {string} categoryId
 */
export async function applyCategory(transactionId, categoryId) {
  await api.updateTransaction(transactionId, { category: categoryId });
}

export async function disconnect() {
  if (connected) {
    await api.shutdown();
    connected = false;
  }
  cachedGroups = null;
}

/**
 * @returns {Promise<object[]>}
 */
export async function getCategories() {
  const raw = await api.getCategories();
  return Array.isArray(raw) ? raw : [];
}

/**
 * @returns {Promise<object[]>}
 */
export async function getAccounts() {
  return api.getAccounts();
}

/**
 * @returns {Promise<object[]>}
 */
export async function getPayees() {
  return api.getPayees();
}

/**
 * @returns {Promise<object[]>}
 */
export async function getSchedules() {
  return api.getSchedules();
}

/**
 * Deletes a category. Actual throws if transactions still reference it (unless transferCategoryId is used).
 * @param {string} categoryId
 * @param {string} [transferCategoryId]
 * @returns {Promise<void>}
 */
export async function deleteCategory(categoryId, transferCategoryId) {
  await api.deleteCategory(categoryId, transferCategoryId);
}

export function transactionPayeeLabel(t, payeeById) {
  if (t.imported_payee) return t.imported_payee;
  if (t.payee_name) return t.payee_name;
  if (t.payee && payeeById?.has(t.payee)) return payeeById.get(t.payee);
  return '(no payee)';
}
