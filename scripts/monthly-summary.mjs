import * as api from '@actual-app/api';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import { connect, getAccounts, getCategories, getPayees, disconnect } from '../src/actual.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * @param {string[]} argv
 */
function resolveTargetMonth(argv) {
  const save = argv.includes('--save');
  const last = argv.includes('--last');
  const rest = argv.filter((a) => a !== '--save' && a !== '--last');
  const ymArg = rest.find((a) => /^\d{4}-\d{2}$/.test(a));

  if (ymArg) {
    return { month: ymArg, save };
  }

  const now = new Date();
  if (last) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return { month: `${y}-${m}`, save };
  }

  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return { month: `${y}-${m}`, save };
}

/**
 * @param {string} ym
 */
function monthDisplayTitle(ym) {
  const [y, mo] = ym.split('-').map(Number);
  const d = new Date(y, mo - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * @param {string} ym
 */
function monthDateRangeLine(ym) {
  const [y, mo] = ym.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const lastDay = new Date(y, mo, 0).getDate();
  const last = new Date(y, mo - 1, lastDay);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${first.toLocaleDateString('en-US', opts)} - ${last.toLocaleDateString('en-US', opts)}`;
}

/**
 * @param {object} t
 * @param {Map<string, string>} payeeById
 */
function payeeLabel(t, payeeById) {
  if (t.imported_payee) return t.imported_payee;
  if (t.payee_name) return t.payee_name;
  if (t.payee && payeeById?.has(t.payee)) return payeeById.get(t.payee);
  return '(no payee)';
}

/**
 * @param {string} name
 */
function isSavingsCategoryName(name) {
  return /\bsavings\b/i.test(String(name || ''));
}

/**
 * Excluded from spending/category breakdown (Actual system categories).
 * @param {string} name
 */
function shouldExcludeBudgetCategoryName(name) {
  const n = String(name || '').trim();
  return n === 'Starting Balances' || n === 'Income';
}

/**
 * @param {object[]} filtered
 * @param {Map<string, string>} catIdToName
 */
function resolveCatName(t, catIdToName) {
  const cid = t.category;
  return cid != null && cid !== ''
    ? catIdToName.get(cid) ?? '(uncategorized)'
    : '(uncategorized)';
}

/**
 * @param {object[]} allTxs
 * @param {string} monthYm
 * @param {Map<string, string>} payeeById
 */
function buildIncomeSourcesForMonth(allTxs, monthYm, payeeById, excludedIds = new Set()) {
  const map = new Map();
  for (const t of allTxs) {
    if (t.id != null && excludedIds.has(t.id)) continue;
    if (!t.date || !String(t.date).startsWith(monthYm) || Number(t.amount) <= 0)
      continue;
    const label = payeeLabel(t, payeeById);
    map.set(label, (map.get(label) || 0) + Number(t.amount) / 100);
  }
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return '(none detected)';
  const lines = [];
  for (let i = 0; i < sorted.length; i++) {
    const [name, amt] = sorted[i];
    let tag = '';
    if (i === 0) tag = ' (primary)';
    else if (i === 1) tag = ' (secondary)';
    lines.push(`  ${name}: $${amt.toFixed(2)}${tag}`);
  }
  return lines.join('\n');
}

function importedPayeeSignalsReversalSummary(t) {
  const imp = String(t.imported_payee || '');
  return /reversal|chargeback/i.test(imp);
}

function txDayMsSummary(t) {
  const ds = String(t.date || '').slice(0, 10);
  const ms = Date.parse(ds);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {object[]} monthTxs
 * @param {Map<string, string>} catIdToName
 * @param {Map<string, string>} payeeById
 */
function findReversalExclusionsForMonth(monthTxs, catIdToName, payeeById) {
  const excludedIds = new Set();
  /** @type {{ payee: string, amount: number, chargeDate: string, reversalDate: string }[]} */
  const pairs = [];
  const used = new Set();
  const reversalTxs = monthTxs.filter((t) => importedPayeeSignalsReversalSummary(t));

  for (const rev of reversalTxs) {
    if (used.has(rev.id)) continue;
    const absAmt = Math.abs(Number(rev.amount));
    if (!Number.isFinite(absAmt) || absAmt === 0) continue;
    const cat = rev.category;
    const revMs = txDayMsSummary(rev);
    if (!Number.isFinite(revMs)) continue;

    const candidates = monthTxs
      .filter(
        (t) =>
          t.id !== rev.id &&
          !used.has(t.id) &&
          t.category === cat &&
          Math.abs(Number(t.amount)) === absAmt &&
          !importedPayeeSignalsReversalSummary(t) &&
          Number.isFinite(txDayMsSummary(t)) &&
          Math.abs(txDayMsSummary(t) - revMs) <= 5 * 86400000,
      )
      .sort(
        (a, b) =>
          Math.abs(txDayMsSummary(a) - revMs) - Math.abs(txDayMsSummary(b) - revMs),
      );

    const charge = candidates[0];

    if (charge) {
      used.add(rev.id);
      used.add(charge.id);
      excludedIds.add(rev.id);
      excludedIds.add(charge.id);
      const neg =
        Number(charge.amount) < 0 ? charge : Number(rev.amount) < 0 ? rev : charge;
      const expenseDollars = Math.abs(Math.min(0, Number(neg.amount)) / 100);
      pairs.push({
        payee: payeeLabel(charge, payeeById),
        amount: expenseDollars,
        chargeDate: String(charge.date),
        reversalDate: String(rev.date),
      });
    } else {
      excludedIds.add(rev.id);
    }
  }

  return { excludedIds, pairs };
}

/**
 * @param {Record<string, { total: number, count: number, transactions: object[] }>} byCategory
 */
function buildOneTimePurchases(byCategory) {
  /** @type {{ payee: string, amount: number, category: string, percentOfCategory: string }[]} */
  const out = [];
  for (const [catName, bucket] of Object.entries(byCategory)) {
    if (shouldExcludeBudgetCategoryName(catName)) continue;
    const total = bucket.total;
    const expenseTxs = bucket.transactions.filter((x) => x.amount < 0);
    const n = expenseTxs.length;
    if (n === 0 || total <= 0.005) continue;
    const avg = total / n;
    for (const tx of expenseTxs) {
      const absAmt = -tx.amount;
      if (absAmt > avg * 3) {
        const pct = ((absAmt / total) * 100).toFixed(0);
        const displayPayee =
          (tx.importedPayee && String(tx.importedPayee).trim()) || tx.payee || '(no payee)';
        out.push({
          payee: displayPayee,
          amount: absAmt,
          category: catName,
          percentOfCategory: pct,
        });
      }
    }
  }
  return out;
}

/**
 * @param {object[]} allTxs
 * @param {Map<string, string>} catIdToName
 * @param {string} monthYm
 * @param {Map<string, string>} payeeById
 * @param {Set<string>} excludedIds
 */
function buildMonthData(allTxs, catIdToName, monthYm, payeeById, excludedIds = new Set()) {
  const filtered = allTxs.filter(
    (t) =>
      t.date &&
      String(t.date).startsWith(monthYm) &&
      Number(t.amount) !== 0 &&
      !(t.id != null && excludedIds.has(t.id)),
  );

  /** Sum of all positive inflows (not category "Income" totals). */
  let totalIncome = 0;
  let totalExpenses = 0;
  let totalSavings = 0;

  /** @type {Record<string, { total: number, count: number, transactions: object[] }>} */
  const byCategory = {};
  /** @type {Map<string, number>} */
  const merchantSpend = new Map();

  for (const t of filtered) {
    const amt = Number(t.amount) / 100;
    const cid = t.category;
    const catName = resolveCatName(t, catIdToName);
    const excluded = shouldExcludeBudgetCategoryName(catName);
    const savingsCat = isSavingsCategoryName(catName);

    if (amt > 0) {
      totalIncome += amt;
    } else if (amt < 0 && !excluded && !savingsCat) {
      totalExpenses += -amt;
    }

    if (cid && isSavingsCategoryName(catIdToName.get(cid) ?? '')) {
      totalSavings += amt;
    }

    if (excluded) continue;

    if (!byCategory[catName]) {
      byCategory[catName] = { total: 0, count: 0, transactions: [] };
    }
    byCategory[catName].count++;
    if (amt < 0) {
      byCategory[catName].total += -amt;
    }
    byCategory[catName].transactions.push({
      payee: payeeLabel(t, payeeById),
      importedPayee: t.imported_payee ? String(t.imported_payee) : '',
      amount: amt,
      date: t.date,
    });
  }

  for (const t of filtered) {
    const amt = Number(t.amount);
    if (amt >= 0) continue;
    const catName = resolveCatName(t, catIdToName);
    if (shouldExcludeBudgetCategoryName(catName)) continue;
    const label = payeeLabel(t, payeeById);
    merchantSpend.set(label, (merchantSpend.get(label) || 0) + -amt / 100);
  }

  const topMerchants = [...merchantSpend.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, total]) => ({ name, total }));

  const largestCandidates = filtered.filter((t) => {
    const cn = resolveCatName(t, catIdToName);
    return !shouldExcludeBudgetCategoryName(cn);
  });
  const largestTransactions = [...largestCandidates]
    .sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))
    .slice(0, 5)
    .map((t) => ({
      payee: payeeLabel(t, payeeById),
      amount: Number(t.amount) / 100,
      date: t.date,
      category: t.category ? catIdToName.get(t.category) ?? t.category : '(uncategorized)',
    }));

  const unusualTransactions = [];
  const byCatTxs = new Map();
  for (const t of filtered) {
    const cn = resolveCatName(t, catIdToName);
    if (shouldExcludeBudgetCategoryName(cn)) continue;
    const cid = t.category ?? '';
    if (!byCatTxs.has(cid)) byCatTxs.set(cid, []);
    byCatTxs.get(cid).push(t);
  }
  for (const [, txs] of byCatTxs) {
    const expenses = txs.filter((x) => Number(x.amount) < 0);
    if (expenses.length < 2) continue;
    const absVals = expenses.map((x) => -Number(x.amount) / 100);
    const avg = absVals.reduce((s, v) => s + v, 0) / absVals.length;
    for (const t of expenses) {
      const a = -Number(t.amount) / 100;
      if (a > 2 * avg) {
        unusualTransactions.push({
          payee: payeeLabel(t, payeeById),
          amount: Number(t.amount) / 100,
          date: t.date,
          category: t.category ? catIdToName.get(t.category) ?? '' : '',
          categoryAvg: avg,
        });
      }
    }
  }

  return {
    month: monthYm,
    totalIncome,
    totalExpenses,
    totalSavings,
    netCashFlow: totalIncome - totalExpenses,
    byCategory,
    topMerchants,
    largestTransactions,
    unusualTransactions,
    _filteredCount: filtered.length,
    _categoryKeys: Object.keys(byCategory).length,
  };
}

/**
 * @param {string} prompt
 */
async function ollamaGenerate(prompt) {
  const url = `${config.OLLAMA_URL}/api/generate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.response ?? '';
}

async function main() {
  const argv = process.argv.slice(2);
  const { month, save } = resolveTargetMonth(argv);

  await connect();
  const payees = await getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));

  const categories = await getCategories();
  const catIdToName = new Map(categories.map((c) => [c.id, c.name]));

  const accounts = await getAccounts();
  /** @type {object[]} */
  const allTxs = [];
  for (const acc of accounts) {
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    allTxs.push(...txs);
  }

  await disconnect();

  const monthTxs = allTxs.filter((t) => t.date && String(t.date).startsWith(month));
  const { excludedIds, pairs: reversalPairs } = findReversalExclusionsForMonth(
    monthTxs,
    catIdToName,
    payeeById,
  );

  const monthData = buildMonthData(allTxs, catIdToName, month, payeeById, excludedIds);

  const incomeSourcesBlock = buildIncomeSourcesForMonth(allTxs, month, payeeById, excludedIds);

  const oneTimePurchases = buildOneTimePurchases(monthData.byCategory);

  const savingsTotal = Math.abs(monthData.totalSavings ?? 0);
  let savingsRateLine = 'N/A';
  if (monthData.totalIncome > 0 && monthData.totalSavings >= 0) {
    savingsRateLine = `${((savingsTotal / monthData.totalIncome) * 100).toFixed(1)}%`;
  }

  const categoryBreakdown = Object.entries(monthData.byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, v]) => `- ${name}: $${v.total.toFixed(2)} (${v.count} transactions)`)
    .join('\n');

  const topMerchantsText = monthData.topMerchants
    .map((m) => `- ${m.name}: $${m.total.toFixed(2)}`)
    .join('\n');

  const largestText = monthData.largestTransactions
    .map(
      (t) =>
        `- ${t.payee} | ${t.category} | $${Math.abs(t.amount).toFixed(2)} | ${t.date}`,
    )
    .join('\n');

  const unusualText =
    monthData.unusualTransactions.length > 0
      ? monthData.unusualTransactions
          .map(
            (t) =>
              `- ${t.payee} | ${t.category} | $${Math.abs(t.amount).toFixed(2)} (category avg ~$${t.categoryAvg.toFixed(2)})`,
          )
          .join('\n')
      : '(none detected)';

  const savingsFramingDollars = Math.abs(monthData.totalSavings ?? 0).toFixed(2);

  const reversalPairsText =
    reversalPairs.length === 0
      ? '(none)'
      : reversalPairs
          .map(
            (p) =>
              `  ${p.payee}: $${p.amount.toFixed(2)} charged ${String(p.chargeDate).slice(0, 10)}, reversed ${String(p.reversalDate).slice(0, 10)}`,
          )
          .join('\n');

  const oneTimePurchasesText =
    oneTimePurchases.length === 0
      ? '(none detected)'
      : oneTimePurchases
          .map(
            (o) =>
              `  ${o.payee}: $${o.amount.toFixed(2)} in ${o.category} (${o.percentOfCategory}% of category)`,
          )
          .join('\n');

  const prompt = `
You are a personal finance advisor reviewing someone's monthly spending.

Category context (follow strictly):
- T-Mobile is in the Bills category, not Dining Out.
- Do not mention Bills payees when discussing Dining Out.
- Only reference payees that actually appear in each category.

Exclude these categories from spending analysis entirely:
 - Transfers (credit card payments, not real expenses)
 - Reimbursements (fraud reversals that net to zero)
 - Starting Balances (one-time account setup)
 - Income (tracked separately)
These are not spending categories.

CRITICAL FRAMING RULES — follow exactly:

1. Savings ($${savingsFramingDollars}) is money transferred TO a savings account.
   ALWAYS describe it as a win: 'You saved $${savingsFramingDollars} this month!'
   NEVER describe savings as spending or an expense.

2. If Shopping is unusually high due to a one-time purchase,
   call it out: 'Shopping was elevated this month due to a
   one-time purchase — your recurring shopping is closer to $X'

3. T-Mobile: if total seems high, note that it may include
   a device purchase — separate recurring plan (~$42-52/mo)
   from one-time hardware costs.

4. Any transaction with 'reversal' or 'chargeback' in the
   payee name nets to zero and should be excluded from
   spending totals entirely. Mention briefly:
   'Note: A payment dispute of $X was reversed this month
   — no net impact on your finances.'

5. Never describe a category total as 'spending' if it
   contains reversals that cancel it out.

Excluded reversal pairs (net zero, not real expenses):
${reversalPairsText}
These are excluded from all totals below.

One-time purchases this month (unusually large vs category average — not recurring):
${oneTimePurchasesText}
Exclude these when assessing whether a category is 'high'.

Analyze this data and write a friendly, honest, plain English summary.

Month: ${monthData.month}
Income (sum of positive inflows): $${monthData.totalIncome.toFixed(2)}
Total Expenses (excl. Starting Balances, category "Income", and Savings transfers): $${monthData.totalExpenses.toFixed(2)}
Net Cash Flow: $${monthData.netCashFlow.toFixed(2)}
Savings (net in Savings-named categories): $${monthData.totalSavings.toFixed(2)}
Savings rate (vs income): ${savingsRateLine}

Income sources this month:
${incomeSourcesBlock}

Spending by category (expense totals; excludes Starting Balances, category "Income", and Savings transfers):
${categoryBreakdown || '(none)'}

Top merchants:
${topMerchantsText || '(none)'}

Largest transactions:
${largestText || '(none)'}

Unusually large vs category average:
${unusualText}

IMPORTANT: Give advice specific to THIS person's data.
- Do NOT mention generic apps like Ibotta or Rakuten unless they 
  already appear in the transaction data
- DO reference specific merchants from their data by name
  (Jack in the Box, Troys Burgers, ARCO, Steam, etc.)
- DO reference specific dollar amounts from their history
- The person lives in the West Covina, CA area — advice should 
  be relevant to Southern California
- If dining out is high, mention specific merchants by name
- If a category spiked one month, call it out specifically

Write a summary with these sections:
1. OVERVIEW - 2-3 sentences on the overall month, income vs spending
2. HIGHLIGHTS - what they spent most on, any surprising categories
3. WINS - what they did well this month
4. WATCH OUT - any categories that seem high or unusual
5. TIP - one specific actionable tip based on their actual spending patterns

Tone: friendly, like a financially savvy friend. Not preachy.
Be specific — mention actual dollar amounts and merchant names.
Keep total length under 400 words.
`.trim();

  let text;
  try {
    text = await ollamaGenerate(prompt);
  } catch (e) {
    console.error('✗ Could not reach Ollama at', config.OLLAMA_URL);
    console.error('  Model:', config.OLLAMA_MODEL);
    console.error('  Error:', e.message);
    console.error('  Start Ollama or set OLLAMA_URL / OLLAMA_MODEL in .env');
    process.exit(1);
  }

  const title = monthDisplayTitle(month);
  const dateRange = monthDateRangeLine(month);

  console.log('');
  console.log('====================================');
  console.log(`  Monthly Summary: ${title}`);
  console.log('====================================');
  console.log('');
  console.log(text.trim());
  console.log('');
  console.log('====================================');
  console.log('  Data used for this summary:');
  console.log(`  - ${monthData._filteredCount} transactions analyzed`);
  console.log(`  - ${monthData._categoryKeys} categories`);
  console.log(`  - Date range: ${dateRange}`);
  console.log('====================================');

  if (save) {
    const dir = join(projectRoot, 'summaries');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `summary-${month}.md`);
    const md = `# Monthly summary: ${title}\n\n${text.trim()}\n\n---\n\n- Transactions: ${monthData._filteredCount}\n- Categories: ${monthData._categoryKeys}\n- Range: ${dateRange}\n`;
    writeFileSync(path, md, 'utf8');
    console.log(`\nWrote ${path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
