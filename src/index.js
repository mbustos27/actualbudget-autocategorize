import { config } from './config.js';
import {
  connect,
  disconnect,
  getUncategorizedTransactions,
  applyCategory,
  transactionPayeeLabel,
  matchOrCreateCategory,
  reloadCategoriesFromBudget,
  getRefinableTransactions,
  categoryNameById,
} from './actual.js';
import {
  assertOllamaReachable,
  getCategorySuggestionFromModel,
  amountToDollarString,
} from './ollama.js';
import {
  getMemoryStats,
  loadMemory,
  recordCategorization,
} from './memory.js';

process.on('unhandledRejection', (reason) => {
  console.error('✗ Unhandled error:', reason);
  process.exit(1);
});

/**
 * @param {'uncategorized' | 'refine'} phase
 * @param {{ accounts: any[], categories: { id: string, name: string }[], payeeById: Map<string, string> }} ctx
 * @param {{ total: { value: number }, phaseLabel: string }} stats
 */
async function runPhase(phase, ctx, stats) {
  const { accounts, categories, payeeById } = ctx;
  const tag = stats.phaseLabel ? `${stats.phaseLabel} ` : '';

  for (const account of accounts) {
    if (account.closed) continue;

    let batch;
    try {
      batch =
        phase === 'refine'
          ? await getRefinableTransactions(
              account.id,
              categories,
              config.REFINE_FROM_CATEGORY_NAMES,
            )
          : await getUncategorizedTransactions(account.id);
    } catch (e) {
      console.error(
        `✗ Failed to load transactions for account "${account.name}" (${account.id}): ${e.message}`,
      );
      continue;
    }

    if (batch.length === 0) continue;

    for (const tx of batch) {
      const payee = transactionPayeeLabel(tx, payeeById);
      const currentCat =
        phase === 'refine'
          ? categoryNameById(categories, tx.category)
          : '';

      try {
        const suggestion = await getCategorySuggestionFromModel(
          tx,
          categories,
          payee,
          phase === 'refine'
            ? { refine: true, currentCategoryName: currentCat }
            : {},
        );

        const beforeId = tx.category;
        const category = await matchOrCreateCategory(suggestion, tx, categories);
        const catName = category?.name ?? '(none)';
        const created = category?.created === true;
        const unchanged =
          phase === 'refine' &&
          category?.id &&
          beforeId &&
          category.id === beforeId;

        const note = created
          ? config.DRY_RUN
            ? ' [would create category]'
            : ' [new category]'
          : '';
        const refineNote =
          phase === 'refine' ? (unchanged ? ' [unchanged]' : ' [refined]') : '';

        if (config.DRY_RUN) {
          console.log(
            `→ [DRY RUN] ${tag}${account.name} | ${payee} | ${amountToDollarString(tx.amount)} → ${catName}${note}${refineNote}`,
          );
        } else {
          if (category?.id && !unchanged) {
            await applyCategory(tx.id, category.id);
          }
          console.log(
            `✓${note}${refineNote} ${tag}${account.name} | ${payee} | ${amountToDollarString(tx.amount)} → ${catName}`,
          );
        }
        if (!unchanged) stats.total.value++;

        if (catName && catName !== '(none)') {
          // record even in dry run so memory improves over time
          recordCategorization(payee, catName);
        }
      } catch (e) {
        console.error(`✗ Transaction ${tx.id} (${payee}): ${e.message}`);
      }
    }
  }
}

async function main() {
  await assertOllamaReachable();
  loadMemory();

  const doubleRun = config.DOUBLE_RUN;
  const refineOnly = config.REFINE_MODE;

  let accounts = [];
  let categories = [];
  /** @type {Map<string, string>} */
  let payeeById = new Map();

  try {
    const conn = await connect();
    accounts = conn.accounts;
    categories = conn.categories;
    payeeById = conn.payeeById;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const ctx = { accounts, categories, payeeById };
  const stats = { total: { value: 0 }, phaseLabel: '' };

  try {
    if (doubleRun) {
      console.log('--- Pass 1/2: uncategorized transactions ---\n');
      stats.phaseLabel = '[1/2]';
      await runPhase('uncategorized', ctx, stats);

      await reloadCategoriesFromBudget(categories);

      console.log('\n--- Pass 2/2: refine broad categories ---\n');
      stats.phaseLabel = '[2/2]';
      await runPhase('refine', ctx, stats);
    } else if (refineOnly) {
      console.log('--- Refine mode: broad categories only ---\n');
      stats.phaseLabel = '';
      await runPhase('refine', ctx, stats);
    } else {
      await runPhase('uncategorized', ctx, stats);
    }
  } finally {
    try {
      await disconnect();
    } catch (e) {
      console.error(`✗ Disconnect issue: ${e.message}`);
    }
  }

  console.log('');
  const kind = doubleRun
    ? 'two-pass run'
    : refineOnly
      ? 'refine pass'
      : 'run';
  console.log(
    `Summary (${kind}): ${stats.total.value} transaction(s) updated across processing.`,
  );
  const memStats = getMemoryStats();
  console.log(
    `Merchant memory: ${memStats.totalMerchants} merchants, ${memStats.totalCategorizations} total categorizations`,
  );
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
});
