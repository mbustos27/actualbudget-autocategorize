import * as api from '@actual-app/api';
import { config } from '../src/config.js';
import {
  connect,
  disconnect,
  applyCategory,
  getCategories,
  getAccounts,
} from '../src/actual.js';

process.on('unhandledRejection', (reason) => {
  console.error('✗ Unhandled error:', reason);
  process.exit(1);
});

// After running, update merchant-memory.json manually or re-run categorizer to let Ollama learn from the fix

const MOVES = [
  { payee: 'e workman ave west', toCategory: 'Cash', note: 'ATM withdrawal' },
  { payee: 'atm withdrawal', toCategory: 'Cash', note: 'ATM cash withdrawal' },
  { payee: 'atm fee', toCategory: 'Cash', note: 'ATM fee' },

  // Process exact-amount matches first
  {
    payee: 't-mobile',
    toCategory: 'Shopping',
    exactAmount: 961.11,
    note: 'Phone purchase — one-time, not a bill',
  },

  // Transfers — credit card payments and generic payments
  { payee: 'chase credit card', toCategory: 'Transfers' },
  { payee: 'payment', toCategory: 'Transfers' },

  // Reimbursements — fraud reversals
  {
    payee: 'reversal scayle payments',
    toCategory: 'Reimbursements',
    note: 'Fraud reversal — nets to zero',
  },
  {
    payee: 'scayle payments web',
    toCategory: 'Reimbursements',
    note: 'Unauthorized charge — reversed Apr 15',
  },

  // Dining Out — restaurants miscategorized as Groceries
  { payee: 'little beijing', toCategory: 'Dining Out' },
  { payee: 'ding tea', toCategory: 'Dining Out' },
  { payee: 'boba tea lounge', toCategory: 'Dining Out' },
];

/** @type {typeof MOVES[number][]} */
const MOVES_EXACT = MOVES.filter((m) => m.exactAmount != null);
/** @type {typeof MOVES[number][]} */
const MOVES_GENERAL = MOVES.filter((m) => m.exactAmount == null);

/**
 * @param {object[]} categories
 * @param {string} name
 */
function findCategoryByName(categories, name) {
  const t = name.trim().toLowerCase();
  if (!t) return null;
  return categories.find((c) => c.name.toLowerCase() === t) ?? null;
}

/**
 * @param {object} tx
 * @param {string} payeeNeedle
 */
function payeeMatches(tx, payeeNeedle) {
  const n = payeeNeedle.trim().toLowerCase();
  const imp = tx.imported_payee != null ? String(tx.imported_payee).trim().toLowerCase() : '';
  const pn = tx.payee_name != null ? String(tx.payee_name).trim().toLowerCase() : '';
  return imp === n || pn === n;
}

/**
 * @param {string} payee
 */
function prettyPayeeTitle(payee) {
  const s = payee.trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) =>
      w
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('-'),
    )
    .join(' ');
}

/**
 * @param {typeof MOVES[number]} move
 */
function logHintFromNote(move) {
  if (!move.note) return '';
  const first = move.note.split(/[—–]/)[0].trim();
  return first.charAt(0).toLowerCase() + first.slice(1);
}

async function main() {
  await connect();

  const rawCats = await getCategories();
  const list = Array.isArray(rawCats) ? rawCats : [];

  const accounts = await getAccounts();

  /** @type {Set<string>} */
  const idsHandledByExact = new Set();

  for (const move of MOVES_EXACT) {
    const exactAmt = Number(move.exactAmount);
    if (!Number.isFinite(exactAmt)) {
      console.error(`✗ Skipping exactAmount rule: invalid exactAmount for "${move.payee}".`);
      continue;
    }

    const targetCat = findCategoryByName(list, move.toCategory);
    if (!targetCat) {
      console.error(`✗ Skipping "${move.payee}": category "${move.toCategory}" not found in budget.`);
      continue;
    }

    let moved = 0;

    for (const acc of accounts) {
      if (acc.closed) continue;
      let txs;
      try {
        txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
      } catch (e) {
        console.error(`✗ Failed loading transactions for ${acc.name}: ${e.message}`);
        continue;
      }

      for (const t of txs) {
        const dollars = Math.abs(Number(t.amount) / 100);
        if (dollars.toFixed(2) !== exactAmt.toFixed(2)) continue;
        if (t.category === targetCat.id) continue;

        if (!config.DRY_RUN) {
          await applyCategory(t.id, targetCat.id);
        }
        idsHandledByExact.add(t.id);
        moved++;
      }
    }

    const suffix = config.DRY_RUN ? ' (DRY RUN — no writes)' : '';
    const hint = logHintFromNote(move);
    const parens = hint ? ` (${hint})` : '';
    const label = prettyPayeeTitle(move.payee);
    const amtStr = exactAmt.toFixed(2);
    const txnWord = moved === 1 ? 'transaction' : 'transactions';
    console.log(
      `Moved ${moved} ${txnWord}: ${label} $${amtStr} → ${targetCat.name}${parens}${suffix}`,
    );
  }

  for (const move of MOVES_GENERAL) {
    const targetCat = findCategoryByName(list, move.toCategory);
    if (!targetCat) {
      console.error(`✗ Skipping "${move.payee}": category "${move.toCategory}" not found in budget.`);
      continue;
    }

    if (move.payee === 'payment') {
      /** @type { { t: object, dollars: number }[]} */
      const candidates = [];
      for (const acc of accounts) {
        if (acc.closed) continue;
        let txs;
        try {
          txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
        } catch (e) {
          console.error(`✗ Failed loading transactions for ${acc.name}: ${e.message}`);
          continue;
        }
        for (const t of txs) {
          if (idsHandledByExact.has(t.id)) continue;
          if (!payeeMatches(t, 'payment')) continue;
          const dollars = Math.abs(Number(t.amount) / 100);
          if (dollars <= 100) continue;
          if (t.category === targetCat.id) continue;
          candidates.push({ t, dollars });
        }
      }
      if (candidates.length > 10) {
        console.warn(
          `Warning: 'payment' matched ${candidates.length} transactions — review before applying`,
        );
      }
      let moved = 0;
      for (const { t, dollars } of candidates) {
        if (!config.DRY_RUN) {
          await applyCategory(t.id, targetCat.id);
        }
        console.log(`Moved Payment $${dollars.toFixed(2)} → ${targetCat.name}`);
        moved++;
      }
      const suffix = config.DRY_RUN ? ' (DRY RUN — no writes)' : '';
      console.log(`Moved ${moved} transactions: [payment] → [${targetCat.name}]${suffix}`);
      continue;
    }

    let moved = 0;

    for (const acc of accounts) {
      if (acc.closed) continue;
      let txs;
      try {
        txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
      } catch (e) {
        console.error(`✗ Failed loading transactions for ${acc.name}: ${e.message}`);
        continue;
      }

      for (const t of txs) {
        if (idsHandledByExact.has(t.id)) continue;
        if (!payeeMatches(t, move.payee)) continue;
        if (t.category === targetCat.id) continue;

        if (!config.DRY_RUN) {
          await applyCategory(t.id, targetCat.id);
        }
        moved++;
      }
    }

    const suffix = config.DRY_RUN ? ' (DRY RUN — no writes)' : '';
    console.log(`Moved ${moved} transactions: [${move.payee}] → [${targetCat.name}]${suffix}`);
  }

  await disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
