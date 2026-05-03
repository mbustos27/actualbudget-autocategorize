import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { config } from '../src/config.js';
import {
  connect,
  disconnect,
  getCategories,
  getAccounts,
  getPayees,
  deleteCategory,
} from '../src/actual.js';
import {
  consolidateCategories,
  countTransactionsByCategory,
  gatherCategoryAuditData,
  printCategoryAuditReport,
  applyAuditRemediation,
  findRedundantCategories,
} from '../src/consolidate.js';
import { loadMemory } from '../src/memory.js';

process.on('unhandledRejection', (reason) => {
  console.error('✗ Unhandled error:', reason);
  process.exit(1);
});

const analyze = process.argv.includes('--analyze');
const fix = process.argv.includes('--fix');
const del = process.argv.includes('--delete');
const useOllama = process.argv.includes('--ollama');
const auto = process.argv.includes('--auto');
const deleteEmpty = process.argv.includes('--delete-empty');

/** Never delete these categories by name (case-insensitive). */
const DELETE_EMPTY_PROTECTED = new Set([
  'savings',
  'income',
  'bills',
  'starting balances',
  'uncategorized',
  'reimbursements',
  'transfers',
  'cash',
]);

/**
 * @param {string} name
 */
function isDeleteEmptyProtected(name) {
  return DELETE_EMPTY_PROTECTED.has(String(name || '').trim().toLowerCase());
}

async function runDeleteEmpty() {
  const dryRun =
    process.argv.includes('--dry-run') || !!config.DRY_RUN;

  await connect();

  const categories = await getCategories();
  const accounts = await getAccounts();
  const counts = await countTransactionsByCategory(accounts);

  /** @type {{ id: string, name: string }[]} */
  const toRemove = [];

  for (const c of categories) {
    if (isDeleteEmptyProtected(c.name)) continue;
    const n = counts.get(c.id) ?? 0;
    if (n === 0) toRemove.push({ id: c.id, name: c.name });
  }

  /** @type {string[]} */
  const removedNames = [];

  for (const c of toRemove) {
    if (dryRun) {
      console.log(`[DRY RUN] Would delete: ${c.name}`);
    } else {
      try {
        await deleteCategory(c.id);
        console.log(`Deleted empty category: ${c.name}`);
      } catch (err) {
        console.error(`Failed to delete category '${c.name}':`, err);
        continue;
      }
    }
    removedNames.push(c.name);
  }

  await disconnect();

  const n = removedNames.length;
  const label = dryRun ? `Would delete ${n} empty categories` : `Deleted ${n} empty categories`;
  console.log('');
  console.log(`${label}:`);
  if (removedNames.length) {
    console.log(removedNames.join(', '));
  }
}

/**
 * @returns {Promise<{ categories: object[], accounts: object[], payeeById: Map<string, string>, audit: Awaited<ReturnType<typeof gatherCategoryAuditData>> }>}
 */
async function loadAudit() {
  const categories = await getCategories();
  const accounts = await getAccounts();
  const payees = await getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));
  const audit = await gatherCategoryAuditData(accounts, categories, payeeById);
  return { categories, accounts, payeeById, audit };
}

/**
 * @param {string} reason
 * @returns {string}
 */
function reportReasonLine(reason) {
  if (reason.startsWith('semantic')) return 'semantic similarity';
  return 'name similarity';
}

async function main() {
  if (deleteEmpty) {
    await runDeleteEmpty();
    return;
  }

  await connect();

  if (analyze && !fix) {
    const { audit } = await loadAudit();
    printCategoryAuditReport(audit);
    await disconnect();
    return;
  }

  if (analyze && fix) {
    const { categories, accounts, payeeById, audit } = await loadAudit();
    printCategoryAuditReport(audit);
    const rl = readline.createInterface({ input, output });
    try {
      await applyAuditRemediation(audit, {
        categories,
        accounts,
        payeeById,
        dryRun: config.DRY_RUN,
        auto,
        deleteAfter: del && config.AUTO_DELETE_EMPTY_CATEGORIES,
        ask: (q) => rl.question(q),
      });
    } finally {
      rl.close();
    }
    console.log('');
    console.log(`DRY_RUN=${config.DRY_RUN}`);
    await disconnect();
    return;
  }

  if (fix && !analyze) {
    loadMemory();
    if (useOllama) {
      if (del && !config.AUTO_DELETE_EMPTY_CATEGORIES) {
        console.warn(
          '\n⚠ --delete ignored: set AUTO_DELETE_EMPTY_CATEGORIES=true in .env to delete empty source categories.',
        );
      }
      console.log('\n--- Applying consolidation (Ollama) ---\n');
      const stats = await consolidateCategories({
        dryRun: config.DRY_RUN,
        useOllama: true,
        manualMap: {},
        deleteAfter: del,
      });
      console.log('');
      console.log('Summary');
      console.log('=======');
      console.log(`Pairs processed: ${stats.pairsProcessed}`);
      console.log(`Transactions remapped (this run): ${stats.totalRemapped}`);
      console.log(`DRY_RUN=${config.DRY_RUN}`);
      await disconnect();
      return;
    }

    const { categories, accounts, payeeById, audit } = await loadAudit();
    const rl = readline.createInterface({ input, output });
    try {
      await applyAuditRemediation(audit, {
        categories,
        accounts,
        payeeById,
        dryRun: config.DRY_RUN,
        auto,
        deleteAfter: del && config.AUTO_DELETE_EMPTY_CATEGORIES,
        ask: (q) => rl.question(q),
      });
    } finally {
      rl.close();
    }
    console.log('');
    console.log(`DRY_RUN=${config.DRY_RUN}`);
    await disconnect();
    return;
  }

  loadMemory();

  const categories = await getCategories();
  const lit = categories.map((c) => ({ id: c.id, name: c.name }));
  const accounts = await getAccounts();
  const counts = await countTransactionsByCategory(accounts);

  const redundant = await findRedundantCategories(lit);

  console.log('');
  console.log('Category Consolidation Report');
  console.log('==============================');
  if (redundant.length === 0) {
    console.log('\nNo potentially redundant category pairs found.');
  } else {
    console.log(`\nFound ${redundant.length} potentially redundant category pairs:\n`);
    redundant.forEach((r, i) => {
      const removeCount = counts.get(r.removeId) ?? 0;
      const keepCount = counts.get(r.keepId) ?? 0;
      console.log(`${i + 1}. REMOVE: ${r.suggestedRemove} (${removeCount} transactions)`);
      console.log(`   KEEP:   ${r.suggestedKeep} (${keepCount} transactions)`);
      console.log(`   Reason: ${reportReasonLine(r.reason)}`);
      console.log('');
    });
    console.log(
      'Run with --fix to remap and optionally delete redundant categories (--delete requires AUTO_DELETE_EMPTY_CATEGORIES=true).',
    );
    console.log('Use npm run analyze for payee-based contamination report.');
    if (!useOllama) {
      console.log('Use --fix --ollama to re-run Ollama per transaction instead of direct remap.');
    }
  }

  await disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
