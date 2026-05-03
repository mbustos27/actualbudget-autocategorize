import * as api from '@actual-app/api';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import {
  connect,
  getAccounts,
  getCategories,
  getPayees,
  getSchedules,
  disconnect,
} from '../src/actual.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let months = 3;
  let exportFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') {
      exportFlag = true;
    } else if (a === '--months' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 1) months = Math.floor(n);
    }
  }
  return { months, export: exportFlag };
}

/**
 * @param {number} n
 */
function lastNCalendarMonthKeys(n) {
  /** @type {string[]} */
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
  }
  return out;
}

/**
 * Exclude incomplete current month from averages when day < 25.
 * @param {string[]} monthKeys
 * @param {Date} [now]
 */
function resolveMonthsForAverages(monthKeys, now = new Date()) {
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const currentYm = `${y}-${String(mo).padStart(2, '0')}`;
  const lastInWindow = monthKeys[monthKeys.length - 1];
  const day = now.getDate();

  if (lastInWindow === currentYm && day < 25) {
    const filtered = monthKeys.filter((m) => m !== currentYm);
    if (!filtered.length) {
      return { monthsForAvg: [...monthKeys], excludedPartialYm: null, partialNote: '' };
    }
    const [yy, mm] = currentYm.split('-').map(Number);
    const label = new Date(yy, mm - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
    return {
      monthsForAvg: filtered,
      excludedPartialYm: currentYm,
      partialNote: `${label} is a partial month — excluded from averages.`,
    };
  }

  return { monthsForAvg: [...monthKeys], excludedPartialYm: null, partialNote: '' };
}

/**
 * Categories excluded from budgeting / category analysis (matches Actual Budget system names).
 * @param {string} name
 */
function shouldExcludeBudgetCategoryName(name) {
  const n = String(name || '').trim();
  return (
    n === 'Starting Balances' ||
    n === 'Income' ||
    n === 'Reimbursements' ||
    n === 'Transfers' ||
    n === 'Transfer' ||
    n === 'Cash'
  );
}

/**
 * @param {string} name
 */
function isSavingsCategoryName(name) {
  return /\bsavings\b/i.test(String(name || ''));
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
 * Sum of positive inflows for a calendar month (all accounts).
 * @param {object[]} allTxs
 * @param {string} monthYm
 */
function monthlyIncomeFromTxs(allTxs, monthYm) {
  return (
    allTxs
      .filter(
        (t) =>
          t.date &&
          String(t.date).startsWith(monthYm) &&
          Number(t.amount) > 0,
      )
      .reduce((sum, t) => sum + Number(t.amount), 0) / 100
  );
}

/**
 * @param {number[]} values
 */
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * @param {number[]} values
 */
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Prefer Mar + Apr monthly totals when both exist in the averaging window; else avg all Jan–Apr months present.
 * @param {{ month: string, income: number }[]} monthlyIncomes
 */
function peakMonthlyIncomeFromPeakMonths(monthlyIncomes) {
  const mar = monthlyIncomes.find((m) => Number(m.month.slice(5, 7)) === 3);
  const apr = monthlyIncomes.find((m) => Number(m.month.slice(5, 7)) === 4);
  if (mar && apr) return (mar.income + apr.income) / 2;
  const peakVals = monthlyIncomes
    .filter((m) => {
      const mo = Number(m.month.slice(5, 7));
      return mo >= 1 && mo <= 4;
    })
    .map((m) => m.income);
  return peakVals.length ? mean(peakVals) : 0;
}

/**
 * Monday-start week bucket (local) for grouping inflows.
 * @param {number} y
 * @param {number} mo 1-12
 * @param {number} day
 */
function mondayWeekStartMs(y, mo, day) {
  const d = new Date(y, mo - 1, day);
  const dow = d.getDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + offsetToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

/**
 * True if calendar date (YYYY-MM-DD) is strictly after PEAK_SEASON_END that year.
 * @param {string} dateStr
 * @param {string} peakEnd MM-DD
 */
function isDateAfterPeakSeasonEnd(dateStr, peakEnd) {
  const ye = parseMMDDParts(peakEnd);
  const ds = String(dateStr).slice(0, 10);
  const [y, mo, d] = ds.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
  const t = new Date(y, mo - 1, d, 12, 0, 0, 0);
  const end = new Date(y, ye.mm - 1, ye.dd, 23, 59, 59, 999);
  return t > end;
}

/**
 * Off-season income when no May+ months in averages:
 * 1) Positive inflows after PEAK_SEASON_END → mean of weekly bucket totals × 4.33
 * 2) Else most recent 4 deposits (any date); median of lowest 50% × 4.33 (conservative)
 * @param {object[]} allTxs
 * @param {string} peakEnd MM-DD from env
 * @returns {{ monthly: number, label: string }}
 */
function estimateOffSeasonMonthlyIncomeFromDeposits(allTxs, peakEnd) {
  /** @type {Map<number, number>} */
  const weekSumAfterPeak = new Map();
  for (const t of allTxs) {
    if (!t.date || Number(t.amount) <= 0) continue;
    const ds = String(t.date).slice(0, 10);
    if (!isDateAfterPeakSeasonEnd(ds, peakEnd)) continue;
    const [y, mo, day] = ds.split('-').map(Number);
    if (!Number.isFinite(y)) continue;
    const k = mondayWeekStartMs(y, mo, day);
    const amt = Number(t.amount) / 100;
    weekSumAfterPeak.set(k, (weekSumAfterPeak.get(k) || 0) + amt);
  }
  const weeklyAfterPeak = [...weekSumAfterPeak.values()].filter((w) => w > 0.005);
  if (weeklyAfterPeak.length) {
    const avgWeek = mean(weeklyAfterPeak);
    return {
      monthly: avgWeek * 4.33,
      label: '(from deposits after peak season end; weekly avg × 4.33)',
    };
  }

  const dated = allTxs
    .filter((t) => t.date && Number(t.amount) > 0)
    .map((t) => {
      const ds = String(t.date).slice(0, 10);
      const ms = Date.parse(ds);
      return { ms, amt: Number(t.amount) / 100 };
    })
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => b.ms - a.ms);

  const recentAmts = dated.slice(0, 4).map((x) => x.amt);
  if (!recentAmts.length) {
    return { monthly: 0, label: '' };
  }
  const sorted = [...recentAmts].sort((a, b) => a - b);
  const n = sorted.length;
  const half = Math.max(1, Math.floor(n / 2));
  const lower = sorted.slice(0, half);
  const weekEst = median(lower);
  return {
    monthly: weekEst * 4.33,
    label: '(conservative estimate from recent deposits)',
  };
}

/**
 * @param {{ stat: object, suggested: number }[]} rows
 */
function sumSuggestedBudget(rows) {
  return rows.reduce((s, r) => s + r.suggested, 0);
}

/**
 * Map expense category name → fixed-cost bucket (non-discretionary shell).
 * @param {string} name
 */
function matchFixedExpenseBucket(name) {
  const n = String(name || '');
  if (/bills/i.test(n)) return 'Bills';
  if (/utilities/i.test(n)) return 'Utilities';
  if (/software/i.test(n)) return 'Software';
  if (/\b(auto\s*&\s*gas|auto\b|\bgas\b|fuel|automotive)\b/i.test(n)) return 'Auto & Gas';
  return null;
}

/** Hard floor sum for off-season fixed categories (parsing / model miss). */
const OFF_SEASON_FIXED_FLOORS = {
  Bills: 363,
  'Auto & Gas': 306,
  Utilities: 97,
  Software: 60,
};
const OFF_SEASON_FIXED_FLOOR_TOTAL = Object.values(OFF_SEASON_FIXED_FLOORS).reduce(
  (s, v) => s + v,
  0,
);

/**
 * @param {{ stat: object, suggested: number }[] | null | undefined} rows
 */
function sumScaledVariableOffBudget(rows) {
  if (!rows?.length) return 0;
  let s = 0;
  for (const r of rows) {
    if (matchFixedExpenseBucket(r.stat.name)) continue;
    s += r.suggested;
  }
  return s;
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 */
function partitionOffSeasonFixedVariable(categoryStats) {
  /** @type {Map<string, { total: number, names: string[] }>} */
  const buckets = new Map();
  /** @type {string[]} */
  const variableNames = [];
  for (const c of categoryStats) {
    if (shouldExcludeBudgetCategoryName(c.name)) continue;
    const bucket = matchFixedExpenseBucket(c.name);
    if (bucket) {
      const cur = buckets.get(bucket) || { total: 0, names: [] };
      cur.total += c.monthlyAvg;
      cur.names.push(c.name);
      buckets.set(bucket, cur);
    } else if (c.monthlyAvg > 0.005) {
      variableNames.push(c.name);
    }
  }
  return { buckets, variableNames };
}

/**
 * @param {{ buckets: Map<string, { total: number, names: string[] }>, variableNames: string[] }} partition
 * @param {number} offMonthlyIncome
 */
function buildOffSeasonFixedVariablePrompt(partition, offMonthlyIncome) {
  const { buckets, variableNames } = partition;
  const order = ['Bills', 'Utilities', 'Software', 'Auto & Gas'];
  /** @type {string[]} */
  const fixedLines = [];
  let totalFixed = 0;

  for (const key of order) {
    const b = buckets.get(key);
    if (!b || b.total < 0.005) continue;
    totalFixed += b.total;
    const note =
      key === 'Bills'
        ? 'non-negotiable recurring obligations'
        : key === 'Utilities'
          ? 'electricity, water — baseline'
          : key === 'Software'
            ? 'professional tools — keep'
            : 'transport — need vehicle';
    fixedLines.push(`- ${key}: $${b.total.toFixed(0)} (${b.names.join(', ')}) — ${note}`);
  }
  for (const [k, v] of buckets) {
    if (order.includes(k) || v.total < 0.005) continue;
    totalFixed += v.total;
    fixedLines.push(`- ${k}: $${v.total.toFixed(0)} (${v.names.join(', ')})`);
  }

  const available = Math.max(0, offMonthlyIncome - totalFixed);
  const variableList =
    variableNames.slice(0, 18).join(', ') || '(see category breakdown)';

  /** @type {string[]} */
  const floorRules = [];
  for (const key of order) {
    const b = buckets.get(key);
    if (!b || b.total < 0.005) continue;
    const floor = Math.max(0, Math.round((b.total * 0.82) / 5) * 5);
    floorRules.push(`${key} below ~$${floor}`);
  }

  return `CRITICAL — off-season budget rules:

FIXED COSTS (do not reduce — same regardless of income):
${fixedLines.join('\n')}
Total fixed: ~$${totalFixed.toFixed(0)}/month — cannot go below this

ABSOLUTE MINIMUMS — never suggest below these amounts 
 regardless of income level:

 Bills:     $363  (Department of Education loan + T-Mobile — fixed)
 Auto & Gas: $306 (fuel — not seasonal, cannot reduce)
 Utilities:  $97  (electricity/water — fixed)
 Software:   $60  (professional tools — fixed)
 
 These are hard floors. If income is tight, reduce ONLY:
 - Dining Out (biggest lever — currently $1,029)
 - Shopping (second lever — currently $1,067)
 - Entertainment
 - Hobbies
 Never touch fixed costs to make the budget balance.

VARIABLE COSTS (scale these to fit remaining income):
Off-season income:     $${offMonthlyIncome.toFixed(2)}
Minus fixed costs:     $${totalFixed.toFixed(2)}
Available for variable: $${available.toFixed(2)}

Allocate $${available.toFixed(2)} across:
- Savings (draw down or minimal contribution)
- Dining Out (biggest reduction opportunity)
- Groceries
- Shopping
- Entertainment
- Hobbies
(and other variable categories from this budget: ${variableList})

Do NOT suggest ${floorRules.length ? floorRules.join('; ') : 'fixed buckets far below typical'} — these are real fixed obligations unless a bill was actually canceled.

Do NOT proportionally scale every category to off-season income — fixed costs stay at realistic baseline amounts.

CRITICAL FORMAT RULES for the OFF SEASON budget table:
- Every budget amount must be a single plain dollar number
- NO math expressions like '$826 - fixed + $144'
- NO text like 'draw down' in the amount column
- If Savings is 0, write $0
- Valid example: | Dining Out | $525 |
- Invalid example: | Dining Out | $725 - reduce by 25-30% |
- The amount column must contain ONLY a number like $525
- NEVER put arithmetic in a cell (no "$825 - $100 = $725", no "Reduce… to $525") — one plain dollar value only (e.g. | Shopping | $726 |)

The OFF SEASON table MUST include ALL categories including fixed ones:
Bills, Auto & Gas, Utilities, Software must appear even if unchanged.
Every category must have a row so the burn total is complete.
`;
}

/**
 * @param {string} text
 * @returns {number | null}
 */
function parseOffSeasonBurnFromResponse(text) {
  const lines = text.split('\n');
  let inOffSection = false;
  let total = 0;
  let count = 0;

  for (const line of lines) {
    if (/off.?season/i.test(line)) inOffSection = true;
    if (/peak.?season/i.test(line) && inOffSection) inOffSection = false;
    if (/savings strategy|realistic wins|3.month/i.test(line)) inOffSection = false;
    if (!inOffSection) continue;

    if (/category|recommended|budget|---|===|\*\*\*/i.test(line)) continue;

    // Pipe table: | Category | $525 | — use last $ on line (math in cell)
    if (line.includes('|')) {
      const cells = line.split('|').map((c) => c.trim());
      const categoryCell = cells[1] ?? '';
      if (/^total$/i.test(categoryCell)) continue;

      const matches = [...line.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        const amount = parseFloat(last[1].replace(/,/g, ''));
        if (amount > 0 && amount < 10000) {
          total += amount;
          count++;
        }
      }
      continue;
    }

    const bulletMatch = line.match(/^[+\-*]\s+[^:]+:\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/);
    if (bulletMatch) {
      const amount = parseFloat(bulletMatch[1].replace(/,/g, ''));
      if (amount > 0 && amount < 10000) {
        total += amount;
        count++;
      }
      continue;
    }

    const plainMatch = line.match(/^\s*[^:]+:\s*\*?\*?\$?\s*([\d,]+(?:\.\d{1,2})?)/);
    if (plainMatch) {
      const amount = parseFloat(plainMatch[1].replace(/,/g, ''));
      if (amount > 0 && amount < 10000) {
        total += amount;
        count++;
      }
    }
  }

  console.log(`  Parsed ${count} off-season budget rows, total: $${total.toFixed(2)}`);
  return count >= 3 ? total : null;
}

/**
 * @returns {{ peakStart: string, peakEnd: string, offSeasonMonths: number }}
 */
function readSeasonalEnv() {
  return {
    peakStart: process.env.PEAK_SEASON_START?.trim() || '01-01',
    peakEnd: process.env.PEAK_SEASON_END?.trim() || '04-15',
    offSeasonMonths: Math.max(1, Number.parseInt(process.env.OFF_SEASON_MONTHS || '8', 10) || 8),
  };
}

/**
 * Peak = Jan–Apr (partial tax season); off = May–Dec. Uses calendar month of YYYY-MM only.
 * @param {{ month: string, income: number }[]} monthlyIncomes
 */
function splitCalendarSeasonalIncome(monthlyIncomes) {
  /** @type {number[]} */
  const peakVals = [];
  /** @type {number[]} */
  const offVals = [];
  for (const m of monthlyIncomes) {
    const mo = Number(m.month.slice(5, 7));
    if (mo >= 1 && mo <= 4) peakVals.push(m.income);
    else if (mo >= 5 && mo <= 12) offVals.push(m.income);
  }
  return {
    peakMonthlyIncome: peakVals.length ? mean(peakVals) : 0,
    offMonthlyIncome: offVals.length ? mean(offVals) : 0,
    peakCount: peakVals.length,
    offCount: offVals.length,
  };
}

/**
 * @param {string} mmdd
 */
function parseMMDDParts(mmdd) {
  const [mm, dd] = mmdd.split('-').map((x) => Number.parseInt(String(x), 10));
  return { mm: Number.isFinite(mm) ? mm : 1, dd: Number.isFinite(dd) ? dd : 1 };
}

/**
 * @param {Date} d
 * @param {string} peakStart MM-DD
 * @param {string} peakEnd MM-DD
 */
function dateInPeakSeasonRange(d, peakStart, peakEnd) {
  const ys = parseMMDDParts(peakStart);
  const ye = parseMMDDParts(peakEnd);
  const y = d.getFullYear();
  const start = new Date(y, ys.mm - 1, ys.dd, 0, 0, 0, 0);
  const end = new Date(y, ye.mm - 1, ye.dd, 23, 59, 59, 999);
  const t = new Date(y, d.getMonth(), d.getDate());
  return t >= start && t <= end;
}

/**
 * @param {Date} now
 * @param {string} peakStart
 * @param {string} peakEnd
 */
function getCurrentSeasonLabel(now, peakStart, peakEnd) {
  const inPeak = dateInPeakSeasonRange(now, peakStart, peakEnd);
  return inPeak
    ? `Peak season (${peakStart}–${peakEnd})`
    : `Off season (${peakEnd}–Dec 31)`;
}

/**
 * @param {{ stat: object, suggested: number }[]} rows
 * @param {number} expenseFactor
 * @param {number} savingsFactor
 */
function scaleSuggestedPlanRows(rows, expenseFactor, savingsFactor) {
  return rows.map((row) => {
    const isSav = isSavingsCategoryName(row.stat.name);
    const f = isSav ? savingsFactor : expenseFactor;
    const s = Math.round(Math.max(0, row.suggested * f) / 5) * 5;
    return { stat: row.stat, suggested: s };
  });
}

/**
 * @param {object} account
 */
function accountDisplaySuffix(account) {
  const id = String(account?.id ?? '');
  return id.length >= 4 ? id.slice(-4) : id || '????';
}

/**
 * Sum balances for accounts whose name matches /savings/i (Actual stores amounts in cents).
 * @param {object[]} accounts
 */
function savingsAccountsAndTotal(accounts) {
  const savingsAccounts = accounts.filter((a) => /savings/i.test(String(a.name || '')));
  const totalSavings =
    savingsAccounts.reduce((s, a) => s + Number(a.balance ?? 0), 0) / 100;
  return { savingsAccounts, totalSavings };
}

/**
 * @param {string} key
 * @returns {number | null}
 */
function parseEnvAccountBalance(key) {
  const v = process.env[key];
  if (v == null || String(v).trim() === '') return null;
  const n = Number.parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number} n
 */
function formatUsdAmount(n) {
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  if (n < 0) return `-$${s}`;
  return `$${s}`;
}

/**
 * Env: all three ACCOUNT_BALANCE_* and BALANCE_AS_OF_DATE set → use .env as source of truth for balances & runway (CHASE_SAVINGS).
 * Otherwise: use Actual account balances from API (may differ from bank).
 * @param {object[]} accounts
 */
function resolveBalanceSnapshot(accounts) {
  const asOfDate = process.env.BALANCE_AS_OF_DATE?.trim() || null;
  const bCollege = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_COLLEGE');
  const bSavings = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_SAVINGS');
  const bFreedom = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_FREEDOM');

  const useEnv =
    Boolean(asOfDate) && bCollege != null && bSavings != null && bFreedom != null;

  /** @type {{ match: RegExp, fallbackLabel: string, envBalance: number | null, kind: 'checking'|'savings'|'credit' }[]} */
  const specs = [
    {
      match: /college/i,
      fallbackLabel: 'CHASE COLLEGE',
      envBalance: bCollege,
      kind: 'checking',
    },
    {
      match: /savings/i,
      fallbackLabel: 'CHASE SAVINGS',
      envBalance: bSavings,
      kind: 'savings',
    },
    {
      match: /freedom/i,
      fallbackLabel: 'Chase Freedom Unlimited',
      envBalance: bFreedom,
      kind: 'credit',
    },
  ];

  /** @type {{ label: string, suffix: string, balance: number, annotation: string }[]} */
  const rows = [];

  for (const spec of specs) {
    const acc = accounts.find((a) => spec.match.test(String(a.name || '')));
    const suffix = acc ? accountDisplaySuffix(acc) : '????';
    const label = acc?.name?.trim() ? acc.name.trim() : spec.fallbackLabel;
    let balance;
    if (useEnv && spec.envBalance != null) {
      balance = spec.envBalance;
    } else if (acc) {
      balance = Number(acc.balance ?? 0) / 100;
    } else {
      balance = 0;
    }
    const annotation =
      spec.kind === 'checking'
        ? '(checking)'
        : spec.kind === 'savings'
          ? '(savings) ← runway source'
          : '(credit card — liability)';
    rows.push({ label, suffix, balance, annotation });
  }

  const collegeBal = rows[0]?.balance ?? 0;
  const savingsBal = rows[1]?.balance ?? 0;
  const freedomBal = rows[2]?.balance ?? 0;
  const netWorthExclLiabilities = collegeBal + savingsBal;
  const netWorthInclLiabilities = collegeBal + savingsBal + freedomBal;

  const { savingsAccounts, totalSavings: apiSavingsTotal } = savingsAccountsAndTotal(accounts);
  const totalSavings = useEnv ? /** @type {number} */ (bSavings) : apiSavingsTotal;

  return {
    useEnv,
    asOfDate,
    rows,
    netWorthExclLiabilities,
    netWorthInclLiabilities,
    totalSavings,
    savingsAccounts,
    savingsBalanceSource: useEnv
      ? '.env ACCOUNT_BALANCE_CHASE_SAVINGS'
      : 'Actual savings account balance(s) matching /savings/i',
  };
}

/**
 * @param {object} p
 * @param {number} p.peakMonthlyIncome
 * @param {number} p.offMonthlyIncome
 * @param {string} p.offIncomeLabel
 * @param {string} p.currentSeason
 * @param {{ avgMonthlyExpenses: number }} overall
 * @param {number} p.totalSavings
 * @param {number} p.seasonalSavingsTarget
 * @param {number} p.offSeasonMonthlyBurn
 * @param {number} p.runwayMonthsBudgetBased
 * @param {string} p.savingsBalanceSource
 * @param {{ peakStart: string, peakEnd: string, offSeasonMonths: number }} seasonalEnv
 */
function buildTaxSeasonalContextPromptBlock(p, overall, seasonalEnv) {
  const surplus = p.offMonthlyIncome - overall.avgMonthlyExpenses;
  const netShort = Math.max(0, p.offSeasonMonthlyBurn - p.offMonthlyIncome);
  const runwayStr =
    netShort > 0.005
      ? Number.isFinite(p.runwayMonthsBudgetBased)
        ? p.runwayMonthsBudgetBased.toFixed(1)
        : '∞'
      : '∞';
  const runwayNote =
    netShort > 0.005
      ? 'savings ÷ monthly net shortfall (off-season budget − off-season income)'
      : 'income covers off-season budget — no net draw from savings for recurring spend';
  const critical =
    overall.avgMonthlyExpenses > p.offMonthlyIncome
      ? '\n ⚠️ CRITICAL: Average monthly expenses exceed off-season income — unsustainable without peak-season reserves or cuts.'
      : '';

  return `SEASONAL INCOME — CRITICAL CONTEXT:
 This person works in tax preparation — income is highly seasonal.

 Peak season (Jan–Apr 15): avg $${p.peakMonthlyIncome.toFixed(2)}/month
 Off season (Apr 16–Dec):  avg $${p.offMonthlyIncome.toFixed(2)}/month${
    p.offIncomeLabel ? ` ${p.offIncomeLabel}` : ''
  }
 Current period: ${p.currentSeason}

 BUDGET RULES FOR THIS PERSON:
 - Base ALL expense budget recommendations on OFF-SEASON income
   ($${p.offMonthlyIncome.toFixed(2)}/month), not the overall average
 - During off season, savings should DRAW DOWN not increase
 - The goal is to make tax season savings last ${seasonalEnv.offSeasonMonths} months
 - Seasonal savings target = (monthly expenses - off income) x ${seasonalEnv.offSeasonMonths} ≈ $${p.seasonalSavingsTarget.toFixed(2)}
 - If expenses > off income, flag this as CRITICAL${critical}

 Off season monthly income:  $${p.offMonthlyIncome.toFixed(2)}
 Monthly expenses (avg):     $${overall.avgMonthlyExpenses.toFixed(2)}
 Monthly surplus/deficit:    $${surplus.toFixed(2)}
 Tax season savings banked:  $${p.totalSavings.toFixed(2)} (${p.savingsBalanceSource})
 Off-season budget total (suggested): $${p.offSeasonMonthlyBurn.toFixed(2)}
 Monthly net shortfall:      $${netShort.toFixed(2)} (budget − off-season income)
 Months of runway:           ${runwayStr} (${runwayNote})
`;
}

/**
 * @param {number[]} values
 * @param {number} m
 */
function stdSample(values, m) {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((acc, x) => acc + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Trend from first to last month in the averaging window only.
 * @param {{ months: { month: string, total: number, count: number }[] }} stat
 * @param {Set<string>} avgSet
 */
function trendLabel(stat, avgSet) {
  const seq = stat.months.filter((x) => avgSet.has(x.month));
  if (seq.length < 2) return 'stable';
  const first = seq[0].total;
  const last = seq[seq.length - 1].total;
  if (first < 0.5 && last < 0.5) return 'stable';
  if (last > first * 1.05) return 'increasing';
  if (last < first * 0.95) return 'decreasing';
  return 'stable';
}

/**
 * @param {{ months: { month: string, total: number, count: number }[] }} stat
 * @param {Set<string>} avgSet
 */
function volatilityLabel(stat, avgSet) {
  const totals = stat.months.filter((x) => avgSet.has(x.month)).map((x) => x.total);
  if (!totals.length) return 'low';
  const m = mean(totals);
  const sd = stdSample(totals, m);
  const cv = m > 0.01 ? sd / m : sd;
  if (cv > 0.3 || (m < 5 && sd > 15)) return 'high';
  if (cv > 0.15) return 'medium';
  return 'low';
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>> extends (infer U)[] ? U : never} stat
 * @param {number} nMonthsFull
 */
function classifySpendPattern(stat, nMonthsFull) {
  const active = stat.months.filter((m) => m.total > 0.005).length;
  if (active <= 1) return 'one-time';
  if (active >= nMonthsFull) return 'recurring';
  return 'seasonal';
}

/**
 * @param {{ monthlyAvg: number, trend: string, volatility: string }} stat
 */
function computeSuggestedBudget(stat) {
  const avg = stat.monthlyAvg;
  if (avg < 0.005) return 0;

  let suggested = avg;
  if (stat.volatility === 'high') {
    suggested = avg * (1 - 0.125);
  } else if (stat.volatility === 'medium') {
    suggested = avg * (1 - 0.1);
  } else {
    suggested = avg;
  }

  if (stat.trend === 'increasing') {
    suggested = Math.min(suggested, avg * 0.97);
  }

  suggested = Math.round(Math.max(0, suggested) / 5) * 5;
  return suggested;
}

/**
 * @param {number} avg
 * @param {number} suggested
 * @param {string} trend
 */
function formatChangeColumn(avg, suggested, trend) {
  const delta = suggested - avg;
  const pct = avg > 0.005 ? (delta / avg) * 100 : 0;
  const dPart = `${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(0)}`;
  const pAbs = Math.abs(pct).toFixed(0);
  let pctPart = '0%';
  if (delta < -0.005) pctPart = `↓${pAbs}%`;
  else if (delta > 0.005) pctPart = `↑${pAbs}%`;
  let trendFlag = '';
  if (trend === 'increasing') trendFlag = ' ↑';
  else if (trend === 'decreasing') trendFlag = ' ↓';
  return `${dPart} (${pctPart})${trendFlag}`;
}

/**
 * @param {string} ym
 */
function ymDisplayLabel(ym) {
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * @param {Map<string, number> | undefined} reversalDeductionMap
 */
function adjustedCatMonthTotal(catName, ym, rawTotal, reversalDeductionMap) {
  const ded = reversalDeductionMap?.get(`${catName}|${ym}`) ?? 0;
  return Math.max(0, rawTotal - ded);
}

function importedPayeeSignalsReversal(t) {
  const imp = String(t.imported_payee || '');
  return /reversal|chargeback/i.test(imp);
}

function txDayMsIdeate(t) {
  const ds = String(t.date || '').slice(0, 10);
  const ms = Date.parse(ds);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {object[]} monthTxs
 * @param {Map<string, string>} catIdToName
 */
function findReversalPairsForIdeateMonth(monthTxs, catIdToName) {
  /** @type {{ categoryName: string, expenseDollars: number }[]} */
  const pairs = [];
  const used = new Set();
  const reversalTxs = monthTxs.filter((t) => importedPayeeSignalsReversal(t));

  for (const rev of reversalTxs) {
    if (used.has(rev.id)) continue;
    const absAmt = Math.abs(Number(rev.amount));
    if (!Number.isFinite(absAmt) || absAmt === 0) continue;
    const cat = rev.category;
    const revMs = txDayMsIdeate(rev);
    if (!Number.isFinite(revMs)) continue;

    const candidates = monthTxs
      .filter(
        (t) =>
          t.id !== rev.id &&
          !used.has(t.id) &&
          t.category === cat &&
          Math.abs(Number(t.amount)) === absAmt &&
          !importedPayeeSignalsReversal(t) &&
          Number.isFinite(txDayMsIdeate(t)) &&
          Math.abs(txDayMsIdeate(t) - revMs) <= 5 * 86400000,
      )
      .sort(
        (a, b) =>
          Math.abs(txDayMsIdeate(a) - revMs) - Math.abs(txDayMsIdeate(b) - revMs),
      );

    const charge = candidates[0];
    const catName =
      cat && catIdToName.has(cat) ? catIdToName.get(cat) : '(uncategorized)';

    if (charge) {
      used.add(rev.id);
      used.add(charge.id);
      const neg =
        Number(charge.amount) < 0 ? charge : Number(rev.amount) < 0 ? rev : charge;
      const expenseDollars = Math.abs(Math.min(0, Number(neg.amount)) / 100);
      pairs.push({ categoryName: catName, expenseDollars });
    }
  }

  return pairs;
}

/**
 * @param {object[]} allTxs
 * @param {string[]} monthKeysFull
 * @param {Map<string, string>} catIdToName
 */
function computeReversalDeductionByCatMonth(allTxs, monthKeysFull, catIdToName) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const ym of monthKeysFull) {
    const monthTxs = allTxs.filter((t) => t.date && String(t.date).startsWith(ym));
    const pairs = findReversalPairsForIdeateMonth(monthTxs, catIdToName);
    for (const p of pairs) {
      const k = `${p.categoryName}|${ym}`;
      map.set(k, (map.get(k) || 0) + p.expenseDollars);
    }
  }
  return map;
}

/**
 * Spike if any month total > 3× mean of other months (same category).
 * Reversal/chargeback pairs reduce the spike month total before comparing.
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} stats
 * @param {string | null} excludedPartialYm
 * @param {Map<string, number> | undefined} reversalDeductionMap
 */
function detectSpikes(stats, excludedPartialYm, reversalDeductionMap) {
  /** @type {{ category: string, spikeMonth: string, spikeAmount: number, spikeAmountRaw: number, reversalDeduction: number, reversalDominated: boolean, normalAvg: number, ratio: number }[]} */
  const spikes = [];

  for (const s of stats) {
    const monthsWithSpend = s.months.filter(
      (m) => adjustedCatMonthTotal(s.name, m.month, m.total, reversalDeductionMap) > 0.005,
    );
    if (monthsWithSpend.length < 2) continue;

    for (const row of s.months) {
      if (excludedPartialYm && row.month === excludedPartialYm) continue;
      const rawTotal = row.total;
      const ded = reversalDeductionMap?.get(`${s.name}|${row.month}`) ?? 0;
      const adj = adjustedCatMonthTotal(s.name, row.month, rawTotal, reversalDeductionMap);

      const others = s.months
        .filter((m) => m.month !== row.month)
        .filter((m) => !excludedPartialYm || m.month !== excludedPartialYm)
        .map((m) => adjustedCatMonthTotal(s.name, m.month, m.total, reversalDeductionMap));
      if (!others.length) continue;
      const otherAvg = mean(others);
      if (otherAvg < 0.5) continue;
      if (adj > 3 * otherAvg && adj > 5) {
        const reversalDominated = rawTotal > 0 && ded > 0.5 * rawTotal;
        spikes.push({
          category: s.name,
          spikeMonth: row.month,
          spikeAmount: adj,
          spikeAmountRaw: rawTotal,
          reversalDeduction: ded,
          reversalDominated,
          normalAvg: otherAvg,
          ratio: adj / otherAvg,
        });
      }
    }
  }

  const seen = new Set();
  return spikes.filter((sp) => {
    const k = `${sp.category}|${sp.spikeMonth}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {Awaited<ReturnType<typeof detectSpikes>} spikes
 */
function formatSpikesPrompt(spikes) {
  if (!spikes.length) return '(none detected)';
  return spikes
    .map((sp) => {
      const lab = ymDisplayLabel(sp.spikeMonth);
      const mult = sp.ratio >= 10 ? `${sp.ratio.toFixed(0)}x` : `${sp.ratio.toFixed(1)}x`;
      const reversalNote = sp.reversalDominated
        ? ' — spike likely caused by payment dispute that was reversed — may not recur'
        : '';
      return `  ${sp.category} spiked to $${sp.spikeAmount.toFixed(
        0,
      )} in ${lab} vs ~$${sp.normalAvg.toFixed(
        0,
      )} average in other months — ${mult} spike.${reversalNote}`;
    })
    .join('\n');
}

/**
 * @param {Map<string, string>} catIdToName
 */
function findBillsCategoryId(catIdToName) {
  for (const [id, name] of catIdToName) {
    if (String(name).trim().toLowerCase() === 'bills') return id;
  }
  return null;
}

/**
 * @param {Map<string, string>} catIdToName
 */
function findDiningCategoryId(catIdToName) {
  let fallback = null;
  for (const [id, name] of catIdToName) {
    const n = String(name).trim().toLowerCase();
    if (n === 'dining out') return id;
    if (/\bdining\b/i.test(String(name)) && !fallback) fallback = id;
  }
  return fallback;
}

/**
 * Classify a Bills payee as true bill vs suspected transfer.
 * @param {string} label
 * @returns {'true'|'transfer'|'other'}
 */
function classifyBillsPayee(label) {
  const s = String(label).trim();
  const lower = s.toLowerCase();
  if (/^chase credit card$/i.test(s)) return 'transfer';
  if (lower === 'payment') return 'transfer';
  if (/credit card|card payment|transfer/i.test(lower)) return 'transfer';
  if (/department of education/i.test(s)) return 'true';
  if (/interest payment/i.test(s)) return 'true';
  if (/^link\.com$/i.test(s) || /^link$/i.test(s)) return 'true';
  if (/loan|insurance|mortgage|electric|water|internet|phone|mobile/i.test(lower)) {
    return 'true';
  }
  return 'other';
}

/**
 * Split Bills outflows for prompt + investigation.
 * @param {object[]} allTxs
 * @param {string | null} billsCatId
 * @param {Set<string>} monthSet
 * @param {string[]} monthsForAvg
 * @param {Map<string, string>} payeeById
 */
function buildBillsSplitAnalysis(
  allTxs,
  billsCatId,
  monthSet,
  monthsForAvg,
  payeeById,
) {
  if (!billsCatId) {
    return {
      trueMoAvg: 0,
      transferMoAvg: 0,
      otherMoAvg: 0,
      trueByPayee: new Map(),
      transferByPayee: new Map(),
      otherByPayee: new Map(),
      trueCounts: new Map(),
      transferCounts: new Map(),
      otherCounts: new Map(),
    };
  }

  const avgSet = new Set(monthsForAvg);
  /** @type {Map<string, { true: number, transfer: number, other: number }>} */
  const byMonth = new Map();
  for (const ym of monthsForAvg) {
    byMonth.set(ym, { true: 0, transfer: 0, other: 0 });
  }

  /** @type {Map<string, { total: number, count: number }>} */
  const trueByPayee = new Map();
  const transferByPayee = new Map();
  const otherByPayee = new Map();

  for (const t of allTxs) {
    if (!t.date || t.category !== billsCatId || Number(t.amount) >= 0) continue;
    const ym = String(t.date).slice(0, 7);
    if (!monthSet.has(ym)) continue;
    const label = payeeLabel(t, payeeById);
    const add = -Number(t.amount) / 100;
    const kind = classifyBillsPayee(label);
    const bucket = kind === 'transfer' ? 'transfer' : kind === 'true' ? 'true' : 'other';
    const cell = byMonth.get(ym);
    if (cell && avgSet.has(ym)) {
      cell[bucket] += add;
    }
    const map =
      kind === 'transfer' ? transferByPayee : kind === 'true' ? trueByPayee : otherByPayee;
    const cur = map.get(label) || { total: 0, count: 0 };
    cur.total += add;
    cur.count++;
    map.set(label, cur);
  }

  const trueVals = monthsForAvg.map((ym) => byMonth.get(ym)?.true ?? 0);
  const trVals = monthsForAvg.map((ym) => byMonth.get(ym)?.transfer ?? 0);
  const othVals = monthsForAvg.map((ym) => byMonth.get(ym)?.other ?? 0);

  return {
    trueMoAvg: mean(trueVals),
    transferMoAvg: mean(trVals),
    otherMoAvg: mean(othVals),
    trueByPayee,
    transferByPayee,
    otherByPayee,
    trueCounts: new Map(
      [...trueByPayee.entries()].map(([k, v]) => [k, v.count]),
    ),
    transferCounts: new Map(
      [...transferByPayee.entries()].map(([k, v]) => [k, v.count]),
    ),
  };
}

/**
 * Sorted payee list for raw Bills dump.
 * @param {Map<string, { total: number, count: number }>} m
 * @param {number} [limit]
 */
function formatBillsPayeeMap(m, limit = 20) {
  const sorted = [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  if (!sorted.length) return '  (none)';
  return sorted
    .slice(0, limit)
    .map(
      ([name, v]) =>
        `  ${name}: $${v.total.toFixed(2)} (${v.count} transaction${v.count === 1 ? '' : 's'})`,
    )
    .join('\n');
}

/**
 * Bills payee totals (expenses) across the analysis window.
 * @param {object[]} allTxs
 * @param {string | null} billsCatId
 * @param {Set<string>} monthSet
 * @param {Map<string, string>} payeeById
 */
function buildBillsPayeeBreakdown(allTxs, billsCatId, monthSet, payeeById) {
  if (!billsCatId) return { lines: '(no Bills category found)', marchTotal: 0, aprilTotal: 0 };

  /** @type {Map<string, number>} */
  const byPayee = new Map();
  /** @type {Map<string, number>} */
  const marchMap = new Map();
  /** @type {Map<string, number>} */
  const aprilMap = new Map();

  for (const t of allTxs) {
    if (!t.date || t.category !== billsCatId || Number(t.amount) >= 0) continue;
    const ym = String(t.date).slice(0, 7);
    if (!monthSet.has(ym)) continue;
    const label = payeeLabel(t, payeeById);
    const add = -Number(t.amount) / 100;
    byPayee.set(label, (byPayee.get(label) || 0) + add);
    if (ym.endsWith('-03')) marchMap.set(label, (marchMap.get(label) || 0) + add);
    if (ym.endsWith('-04')) aprilMap.set(label, (aprilMap.get(label) || 0) + add);
  }

  const sorted = [...byPayee.entries()].sort((a, b) => b[1] - a[1]);
  const lines =
    sorted.length > 0
      ? sorted
          .slice(0, 15)
          .map(([name, amt]) => `  ${name}: $${amt.toFixed(2)}`)
          .join('\n')
      : '  (no Bills outflows in window)';

  const marchTotal = [...marchMap.values()].reduce((s, v) => s + v, 0);
  const aprilTotal = [...aprilMap.values()].reduce((s, v) => s + v, 0);

  return { lines, marchTotal, aprilTotal };
}

/**
 * Dining merchant visit counts and dollars (expense txs).
 * @param {object[]} allTxs
 * @param {string | null} diningCatId
 * @param {Set<string>} monthSet
 * @param {Map<string, string>} payeeById
 */
function buildDiningMerchantStats(allTxs, diningCatId, monthSet, payeeById) {
  if (!diningCatId) {
    return {
      topLines: '(no Dining category matched)',
      pairLine: '',
      sortedTop: [],
      jit: null,
      troys: null,
    };
  }

  /** @type {Map<string, { visits: number, dollars: number }>} */
  const map = new Map();
  for (const t of allTxs) {
    if (!t.date || t.category !== diningCatId || Number(t.amount) >= 0) continue;
    const ym = String(t.date).slice(0, 7);
    if (!monthSet.has(ym)) continue;
    const label = payeeLabel(t, payeeById);
    const cur = map.get(label) || { visits: 0, dollars: 0 };
    cur.visits++;
    cur.dollars += -Number(t.amount) / 100;
    map.set(label, cur);
  }

  const sorted = [...map.entries()].sort((a, b) => b[1].dollars - a[1].dollars);
  const topLines =
    sorted.length > 0
      ? sorted
          .slice(0, 12)
          .map(([name, v]) => `  ${name}: ${v.visits} visits, $${v.dollars.toFixed(2)}`)
          .join('\n')
      : '  (no dining outflows in window)';

  const jitEntry = sorted.find(([n]) => /jack\s+in\s+the\s+box/i.test(n));
  const troysEntry = sorted.find(([n]) => /troys?\s+burgers/i.test(n));
  let pairLine = '';
  if (jitEntry || troysEntry) {
    const parts = [];
    if (jitEntry)
      parts.push(
        `${jitEntry[0]} (${jitEntry[1].visits} visits, ~$${jitEntry[1].dollars.toFixed(0)})`,
      );
    if (troysEntry)
      parts.push(
        `${troysEntry[0]} (${troysEntry[1].visits} visits, ~$${troysEntry[1].dollars.toFixed(0)})`,
      );
    const combined =
      (jitEntry?.[1].dollars ?? 0) + (troysEntry?.[1].dollars ?? 0);
    pairLine = `Jack in the Box + Troys Burgers (if present): ${parts.join(
      '; ',
    )}. Combined ~$${combined.toFixed(0)}/period in dining data.`;
  }

  return {
    topLines,
    pairLine,
    sortedTop: sorted.slice(0, 5),
    jit: jitEntry
      ? { name: jitEntry[0], visits: jitEntry[1].visits, dollars: jitEntry[1].dollars }
      : null,
    troys: troysEntry
      ? {
          name: troysEntry[0],
          visits: troysEntry[1].visits,
          dollars: troysEntry[1].dollars,
        }
      : null,
  };
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 */
function getBillsCategoryAvg(categoryStats) {
  const b = categoryStats.find((c) => /^bills$/i.test(String(c.name).trim()));
  return b ? b.monthlyAvg : 0;
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>> extends (infer U)[] ? U : never} stat
 */
function isDiningCategoryStat(stat) {
  return /\bdining\b/i.test(stat.name);
}

/**
 * Precomputed suggested amounts (must match export table + narrative instructions).
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 * @param {Awaited<ReturnType<typeof buildDiningMerchantStats>>} diningMeta
 * @param {Awaited<ReturnType<typeof buildBillsSplitAnalysis>>} billsSplit
 * @param {string | null} billsCatId
 */
function buildSuggestedPlan(categoryStats, diningMeta, billsSplit, billsCatId) {
  const diningStat = categoryStats.find(isDiningCategoryStat);
  const aggressiveDining =
    !!diningStat &&
    diningStat.monthlyAvg >= 400 &&
    !!(diningMeta.jit && diningMeta.jit.visits >= 8);

  /** @type {{ stat: object, suggested: number }[]} */
  const rows = [];
  for (const c of budgetRelevantStats(categoryStats)) {
    let suggested = computeSuggestedBudget(c);

    if (billsCatId && /^bills$/i.test(String(c.name).trim())) {
      const base = billsSplit.trueMoAvg + billsSplit.otherMoAvg;
      suggested = Math.round(Math.max(base, 0) / 5) * 5;
    } else if (isSavingsCategoryName(c.name)) {
      suggested = Math.round(Math.max(0, c.monthlyAvg) / 5) * 5;
    } else if (aggressiveDining && isDiningCategoryStat(c)) {
      suggested = Math.round(Math.max(0, c.monthlyAvg * 0.705) / 5) * 5;
    }

    rows.push({ stat: c, suggested });
  }
  return { rows, aggressiveDining, diningStat };
}

/**
 * @param {{ stat: object, suggested: number }[]} rows
 */
function formatExactSuggestedInject(rows) {
  return rows
    .map(
      (r) =>
        `- ${r.stat.name}: **$${r.suggested}/mo** (current avg $${r.stat.monthlyAvg.toFixed(2)})`,
    )
    .join('\n');
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 * @param {Awaited<ReturnType<typeof detectSpikes>>} spikes
 */
function buildUtilitiesCriticalPrompt(categoryStats, spikes) {
  const sp = spikes.find((s) => /utilities/i.test(s.category));
  const u = categoryStats.find((s) => /\butilities\b/i.test(s.name));
  if (sp && sp.ratio >= 3 && u) {
    const others = u.months.filter((m) => m.month !== sp.spikeMonth && m.total > 0);
    let fromAmt = sp.normalAvg;
    let fromLab = 'typical months (avg)';
    if (others.length) {
      const low = others.reduce((a, b) => (a.total < b.total ? a : b));
      fromAmt = low.total;
      fromLab = ymDisplayLabel(low.month);
    }
    const ratio = sp.ratio;
    const revHint = sp.reversalDominated
      ? ' Much of the raw total may be from a charge that was later reversed — clarify dispute vs real utility cost.'
      : '';
    return `⚠️ CRITICAL ANOMALY — MUST mention in your response:
Utilities jumped from $${fromAmt.toFixed(2)} (${fromLab}) to $${sp.spikeAmount.toFixed(
      2,
    )} in ${ymDisplayLabel(sp.spikeMonth)} — 
a ${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}x spike. This is the single most important finding in this data.
In your HIGHLIGHTS section, make this the first thing you mention.
Possible causes: large one-time bill, new subscription, billing error.${revHint}
Tell the user to check their ${ymDisplayLabel(sp.spikeMonth)} Utilities transactions immediately.`;
  }
  if (!u || u.months.length < 2) return '';
  const sorted = [...u.months].sort((a, b) => a.total - b.total);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  if (low.total < 1 || high.total < low.total * 5) return '';
  const ratio = high.total / Math.max(low.total, 0.01);
  if (ratio < 5) return '';
  return `⚠️ CRITICAL ANOMALY — MUST mention in your response:
Utilities jumped from $${low.total.toFixed(2)} in ${ymDisplayLabel(
    low.month,
  )} to $${high.total.toFixed(2)} in ${ymDisplayLabel(high.month)} — 
a ${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}x spike. This is the single most important finding in this data.
In your HIGHLIGHTS section, make this the first thing you mention.
Possible causes: large one-time bill, new subscription, billing error.
Tell the user to check their ${ymDisplayLabel(high.month)} Utilities transactions immediately.`;
}

/**
 * @param {Map<string, { expenses: number, savingsRaw: number }>} byMonth
 * @param {string[]} monthsForAvg
 * @param {Awaited<ReturnType<typeof overallStatsFromMonths>>} overall
 */
function buildSavingsContextPrompt(byMonth, monthsForAvg, overall) {
  const pairs = monthsForAvg.map((ym) => ({
    ym,
    abs: Math.abs(byMonth.get(ym)?.savingsRaw ?? 0),
  }));
  if (!pairs.length) return '(no savings transfer breakdown)';
  const maxP = pairs.reduce((a, b) => (a.abs >= b.abs ? a : b));
  const rest = pairs.filter((p) => p.ym !== maxP.ym);
  const baseline = rest.length ? mean(rest.map((p) => p.abs)) : maxP.abs;
  const pct =
    overall.avgMonthlyIncome > 0
      ? ((overall.avgMonthlySavings / overall.avgMonthlyIncome) * 100).toFixed(1)
      : 'N/A';
  return `Savings context:
  The user is already transferring $${overall.avgMonthlySavings.toFixed(
    2,
  )}/month to Savings-named categories on average.
  This is EXCELLENT — approximately ${pct}% of gross income.
  Do NOT suggest reducing savings.
  Instead, acknowledge this as a major financial win.
  The suggested budget table may show a lower Savings row only because one month had an unusually large transfer ($${maxP.abs.toFixed(
    2,
  )} in ${ymDisplayLabel(maxP.ym)}) — the steadier baseline across other months is closer to $${baseline.toFixed(
    2,
  )}.`;
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>> extends (infer U)[] ? U : never} diningStat
 * @param {Awaited<ReturnType<typeof buildDiningMerchantStats>>} diningMeta
 */
function buildDiningLeverPrompt(diningStat, diningMeta) {
  if (!diningStat || !isDiningCategoryStat(diningStat)) return '';
  const avg = diningStat.monthlyAvg;
  const jit = diningMeta.jit;
  const troys = diningMeta.troys;
  if (avg < 400 && !(jit && jit.visits >= 15)) return '';
  const target = Math.round((avg * 0.705) / 5) * 5;
  let jitLine = '';
  if (jit) {
    const approxSave = Math.min(jit.dollars * 0.35, avg * 0.22);
    jitLine = `Jack in the Box appeared ${jit.visits} times — that is roughly ${jit.visits >= 22 ? 'daily' : 'very frequent'}. Just reducing Jack in the Box to ~every other visit could save ~$${approxSave.toFixed(0)}/month (rough estimate from current spend).`;
  }
  let troysLine = '';
  if (troys) troysLine = ` Troys Burgers appeared ${troys.visits} times.`;
  return `Dining Out: reduce by 25-30% — target ≈ $${target}/month (from ~$${avg.toFixed(0)}/mo avg).
${jitLine}${troysLine}
This is the single biggest lever available in this data.`;
}

/**
 * Data-only Bills section for markdown / console.
 */
function buildBillsInvestigationMd(billsSplit, billsCategoryMoAvg, billsCatId) {
  if (!billsCatId) return '';

  const trueTotal = [...billsSplit.trueByPayee.values()].reduce(
    (s, v) => s + v.total,
    0,
  );
  const trTotal = [...billsSplit.transferByPayee.values()].reduce(
    (s, v) => s + v.total,
    0,
  );

  const trueLines = formatBillsPayeeMap(billsSplit.trueByPayee, 25);
  const trLines = formatBillsPayeeMap(billsSplit.transferByPayee, 25);

  let chase = null;
  let payment = null;
  for (const [k, v] of billsSplit.transferByPayee) {
    if (/chase credit card/i.test(k)) chase = v;
    if (/^payment$/i.test(k)) payment = v;
  }

  return `## Bills Investigation

Your Bills category average of **$${billsCategoryMoAvg.toFixed(
    0,
  )}/month** includes what appear to be credit card payments. Here is the breakdown:

**Likely true bills (loans, services, keywords, named payees):** combined ~$${trueTotal.toFixed(
    2,
  )} over the analysis window (not monthly — sum of classified payees).

${trueLines}

**Likely credit card payments (transfers):** combined ~$${trTotal.toFixed(2)} over the window.

${trLines}

**Action:** In Actual Budget, consider moving **Chase Credit Card** ($${(
    chase?.total ?? 0
  ).toFixed(2)}, ${chase?.count ?? 0} transactions) and **Payment** ($${(
    payment?.total ?? 0
  ).toFixed(2)}, ${payment?.count ?? 0} transactions) to a **Transfer** category so they do not inflate your Bills budget.`;
}

/**
 * Heuristic per-category reduction guidance for the model.
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 * @param {Awaited<ReturnType<typeof buildDiningMerchantStats>>} diningMeta
 */
function buildReductionTargetsBlock(categoryStats, diningMeta) {
  const lines = [];
  lines.push(
    'Apply these reduction targets (NOT a flat percentage across all categories):',
  );

  const expenseLike = categoryStats.filter(
    (c) =>
      !isSavingsCategoryName(c.name) && !/^bills$/i.test(c.name.trim()),
  );

  for (const c of expenseLike.sort((a, b) => b.monthlyAvg - a.monthlyAvg)) {
    const name = c.name;
    if (/software|cursor|openai|github|subscription/i.test(name)) {
      lines.push(` - ${name}: KEEP AS IS — professional / software tools unless data shows waste.`);
      continue;
    }

    let priority = 'MEDIUM';
    let range = '8-12%';
    let note = '';

    if (/dining|restaurant|takeout/i.test(name)) {
      priority = 'HIGH';
      range = '15-20%';
      note =
        diningMeta.pairLine ||
        ' Review frequent small purchases (see dining merchant list above).';
    } else if (/groceries|grocery/i.test(name)) {
      priority = 'LOW';
      range = '0-5%';
      note = ' maintain or slight reduction.';
    } else if (/auto|gas|fuel/i.test(name)) {
      priority = 'LOW';
      range = '0-5%';
      note = ' usually stable; watch only if volatile.';
    } else if (/entertain/i.test(name)) {
      priority = 'LOW';
      range = '5-10%';
      note =
        c.monthlyAvg < 120
          ? ' already reasonable if low.'
          : ' trim optional spends.';
    } else if (/shop|amazon|retail/i.test(name)) {
      priority = 'MEDIUM';
      range = '10%';
      note =
        c.pattern === 'seasonal'
          ? ' seasonal — was $0 some months; avoid averaging spikes into baseline.'
          : '';
    } else if (c.volatility === 'high') {
      priority = 'HIGH';
      range = '10-15%';
      note = ' high volatility — cap increases; trim peak drivers.';
    } else if (c.volatility === 'medium') {
      priority = 'MEDIUM';
      range = '8-12%';
    } else {
      priority = 'LOW';
      range = '0-5%';
      note = ' stable category — hold near current average.';
    }

    lines.push(
      ` - ${name}: ${priority} priority, reduce by ~${range} (currently ~$${c.monthlyAvg.toFixed(
        0,
      )}/mo avg)${note ? ` — ${note}` : ''}`,
    );
  }

  lines.push(
    ' - Bills: DO NOT suggest reducing dollar-for-dollar — validate transfers vs true bills.',
  );
  lines.push(
    ' - Savings (transfers): DO NOT suggest reducing — increasing is the goal.',
  );

  return lines.join('\n');
}

/**
 * @param {object[]} allTxs
 * @param {string[]} monthsForAvg
 * @param {Map<string, string>} payeeById
 */
function computeIncomeStability(allTxs, monthsForAvg, payeeById) {
  const set = new Set(monthsForAvg);
  const incomes = monthsForAvg.map((ym) => monthlyIncomeFromTxs(allTxs, ym));
  const variance =
    incomes.length >= 2 ? Math.max(...incomes) - Math.min(...incomes) : 0;
  const hi = incomes.length ? Math.max(...incomes) : 0;
  const lo = incomes.length ? Math.min(...incomes) : 0;

  /** @type {Map<string, number>} */
  const byPayee = new Map();
  for (const t of allTxs) {
    if (!t.date || Number(t.amount) <= 0) continue;
    const ym = String(t.date).slice(0, 7);
    if (!set.has(ym)) continue;
    const label = payeeLabel(t, payeeById);
    byPayee.set(label, (byPayee.get(label) || 0) + Number(t.amount) / 100);
  }

  const sorted = [...byPayee.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0];
  const secondary = sorted[1];

  let primaryNote = primary
    ? `${primary[0]} (appears to be primary cash-in; often payroll/deposits)`
    : '(unknown)';
  if (/online\s+deposit|check/i.test(primary?.[0] ?? '')) {
    primaryNote = `${primary?.[0]} (likely employment / payroll deposits)`;
  }

  let secondaryLine = '';
  if (secondary) {
    const perMo = secondary[1] / Math.max(1, monthsForAvg.length);
    secondaryLine = `Secondary: ${secondary[0]} (~$${perMo.toFixed(0)}/mo across window — may include side income).`;
  }

  return {
    incomeVariance: variance,
    incomeHi: hi,
    incomeLo: lo,
    primaryIncomeSource: primary?.[0] ?? '(none)',
    secondaryLine,
    stabilityBlock: `Income stability: varied from $${lo.toFixed(2)} to $${hi.toFixed(
      2,
    )} per month across analyzed months (range $${variance.toFixed(2)}).\nPrimary source: ${primaryNote}\n${secondaryLine || 'Secondary: (none prominent)'}`,
  };
}

/**
 * @param {object[]} allTxs
 * @param {Set<string>} monthSet
 * @param {Map<string, string>} catIdToName
 */
function buildMonthlyRollups(allTxs, monthSet, catIdToName) {
  /** @type {Map<string, Map<string, { total: number, count: number }>>} */
  const byCatMonth = new Map();

  /** @type {Map<string, { expenses: number, savingsRaw: number }>} */
  const byMonth = new Map();

  for (const ym of monthSet) {
    byMonth.set(ym, { expenses: 0, savingsRaw: 0 });
  }

  let txInWindow = 0;

  for (const t of allTxs) {
    if (!t.date || Number(t.amount) === 0) continue;
    const ds = String(t.date);
    const ym = ds.slice(0, 7);
    if (!monthSet.has(ym)) continue;
    txInWindow++;

    const amt = Number(t.amount) / 100;
    const cid = t.category;
    const catName =
      cid != null && cid !== ''
        ? catIdToName.get(cid) ?? '(uncategorized)'
        : '(uncategorized)';

    const roll = byMonth.get(ym);
    if (!roll) continue;

    if (amt < 0) {
      const spendName =
        cid != null && cid !== '' ? catName : '(uncategorized)';
      if (!shouldExcludeBudgetCategoryName(spendName)) {
        roll.expenses += -amt;
      }
    }

    if (cid && isSavingsCategoryName(catIdToName.get(cid) ?? '')) {
      roll.savingsRaw += amt;
    }

    if (amt < 0) {
      const spendName =
        cid != null && cid !== '' ? catName : '(uncategorized)';
      if (shouldExcludeBudgetCategoryName(spendName)) continue;

      if (!byCatMonth.has(spendName)) byCatMonth.set(spendName, new Map());
      const mMap = byCatMonth.get(spendName);
      if (!mMap.has(ym)) mMap.set(ym, { total: 0, count: 0 });
      const cell = mMap.get(ym);
      cell.total += -amt;
      cell.count++;
    }
  }

  return { byCatMonth, byMonth, txInWindow };
}

/**
 * @param {Map<string, Map<string, { total: number, count: number }>>} byCatMonth
 * @param {string[]} monthKeysFull
 * @param {Set<string>} avgSet
 */
function buildCategoryStats(byCatMonth, monthKeysFull, avgSet) {
  const list = [];

  for (const [name, mMap] of byCatMonth) {
    if (shouldExcludeBudgetCategoryName(name)) continue;

    /** @type {{ month: string, total: number, count: number }[]} */
    const months = [];
    for (const ym of monthKeysFull) {
      const c = mMap.get(ym);
      months.push({
        month: ym,
        total: c ? c.total : 0,
        count: c ? c.count : 0,
      });
    }
    const txTotal = months.reduce((s, x) => s + x.count, 0);
    if (txTotal === 0) continue;

    const totalsForAvg = months.filter((x) => avgSet.has(x.month)).map((x) => x.total);
    const monthlyAvg = totalsForAvg.length ? mean(totalsForAvg) : mean(months.map((x) => x.total));
    const monthlyMin = months.length ? Math.min(...months.map((x) => x.total)) : 0;
    const monthlyMax = months.length ? Math.max(...months.map((x) => x.total)) : 0;

    const stat = {
      name,
      monthlyAvg,
      monthlyMin,
      monthlyMax,
      trend: 'stable',
      volatility: 'low',
      pattern: /** @type {'one-time'|'recurring'|'seasonal'} */ ('recurring'),
      months,
    };
    stat.trend = trendLabel(stat, avgSet);
    stat.volatility = volatilityLabel(stat, avgSet);
    stat.pattern = classifySpendPattern(stat, monthKeysFull.length);
    list.push(stat);
  }

  list.sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return list;
}

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 */
function budgetRelevantStats(categoryStats) {
  return categoryStats.filter((c) => c.pattern !== 'one-time');
}

/**
 * @param {object[]} allTxs
 * @param {Set<string>} monthSet
 * @param {Map<string, string>} payeeById
 */
function buildIncomeSourceLines(allTxs, monthSet, payeeById) {
  const map = new Map();
  for (const t of allTxs) {
    if (!t.date || Number(t.amount) <= 0) continue;
    const ym = String(t.date).slice(0, 7);
    if (!monthSet.has(ym)) continue;
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

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} stats
 * @param {string[]} monthKeysFull
 */
function formatOneTimeAndRecurringBlocks(stats, monthKeysFull) {
  const oneTime = stats.filter((s) => s.pattern === 'one-time');
  const recurring = stats.filter((s) => s.pattern === 'recurring');
  const seasonal = stats.filter((s) => s.pattern === 'seasonal');

  const fmtOne = (s) => {
    const hit = s.months.find((m) => m.total > 0.005);
    const ym = hit?.month ?? monthKeysFull[0];
    const [y, mo] = ym.split('-').map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
    return `  ${s.name}: $${hit?.total.toFixed(2) ?? '0.00'} (occurred once in ${label})`;
  };

  let out = '';
  out += 'One-time expenses (exclude from monthly budget):\n';
  out +=
    oneTime.length > 0
      ? oneTime.map(fmtOne).join('\n')
      : '  (none in this window)';
  out += '\n\nRecurring expenses (include in monthly budget):\n';
  out +=
    recurring.length > 0
      ? recurring.map((s) => `  ${s.name}: recurring every month`).join('\n')
      : '  (none in this window)';
  out += '\n\nSeasonal / intermittent expenses (partial months):\n';
  out +=
    seasonal.length > 0
      ? seasonal
          .map((s) => {
            const active = s.months.filter((m) => m.total > 0.005).length;
            return `  ${s.name}: spent in ${active} of ${monthKeysFull.length} months`;
          })
          .join('\n')
      : '  (none in this window)';
  return out;
}

/**
 * @param {Map<string, { expenses: number, savingsRaw: number }>} byMonth
 * @param {object[]} allTxs
 * @param {string[]} monthsForAvg
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 */
function overallStatsFromMonths(byMonth, allTxs, monthsForAvg, categoryStats) {
  const incomes = monthsForAvg.map((ym) => monthlyIncomeFromTxs(allTxs, ym));
  const expenses = [];
  const savingsAbs = [];

  for (const ym of monthsForAvg) {
    const r = byMonth.get(ym);
    if (r) {
      expenses.push(r.expenses);
      savingsAbs.push(Math.abs(r.savingsRaw));
    }
  }

  const avgMonthlyIncome = mean(incomes);
  const avgMonthlyExpenses = mean(expenses);
  const avgMonthlySavings = mean(savingsAbs);

  let savingsRateNumeric = null;
  let savingsRateWarn = false;
  if (avgMonthlyIncome > 0) {
    const rawRate = (avgMonthlySavings / avgMonthlyIncome) * 100;
    if (rawRate < 0) {
      savingsRateWarn = true;
      savingsRateNumeric = null;
    } else {
      savingsRateNumeric = rawRate;
    }
  }

  const relevant = budgetRelevantStats(categoryStats);

  let mostVolatileCategory = '';
  let maxCv = -1;
  for (const c of relevant) {
    if (c.monthlyAvg < 5) continue;
    const totals = c.months
      .filter((x) => monthsForAvg.includes(x.month))
      .map((x) => x.total);
    if (totals.length < 2) continue;
    const m = mean(totals);
    const sd = stdSample(totals, m);
    const cv = m > 0.01 ? sd / m : sd;
    if (cv > maxCv) {
      maxCv = cv;
      mostVolatileCategory = c.name;
    }
  }

  let biggestExpenseCategory = '';
  let maxAvg = -1;
  for (const c of relevant) {
    if (c.monthlyAvg > maxAvg) {
      maxAvg = c.monthlyAvg;
      biggestExpenseCategory = c.name;
    }
  }

  let fastestGrowingCategory = '';
  let maxGrowth = -Infinity;
  for (const c of relevant) {
    const avgMonths = c.months
      .filter((x) => monthsForAvg.includes(x.month))
      .sort((a, b) => a.month.localeCompare(b.month));
    if (avgMonths.length < 2) continue;
    const first = avgMonths[0].total;
    const last = avgMonths[avgMonths.length - 1].total;
    const base = Math.max(first, 1);
    const growth = (last - first) / base;
    if (c.monthlyAvg >= 25 && growth > maxGrowth) {
      maxGrowth = growth;
      fastestGrowingCategory = c.name;
    }
  }

  return {
    avgMonthlyIncome,
    avgMonthlyExpenses,
    avgMonthlySavings,
    savingsRateNumeric,
    savingsRateWarn,
    monthsAnalyzed: monthsForAvg.length,
    mostVolatileCategory,
    biggestExpenseCategory,
    fastestGrowingCategory,
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

/**
 * @param {Awaited<ReturnType<typeof buildCategoryStats>>} categoryStats
 * @param {Set<string>} avgSet
 */
function formatCategoryBreakdown(categoryStats, avgSet) {
  return categoryStats
    .map((c) => {
      const vol = c.volatility;
      const tr = c.trend;
      const pat = c.pattern;
      const note =
        avgSet.size < c.months.length
          ? ' (averages exclude partial current month if applicable)'
          : '';
      return `- ${c.name}: avg $${c.monthlyAvg.toFixed(
        2,
      )}/mo over full months used${note} (min $${c.monthlyMin.toFixed(
        2,
      )}, max $${c.monthlyMax.toFixed(2)}) — ${pat}, trend: ${tr}, volatility: ${vol}`;
    })
    .join('\n');
}

/**
 * @param {string} s
 * @param {number} w
 */
function padCol(s, w) {
  const t = String(s).slice(0, w);
  return t.padEnd(w);
}

/**
 * @param {object} schedule
 */
function parseScheduleDateRule(schedule) {
  let d = schedule.date;
  if (d == null) return {};
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return {};
    }
  }
  return typeof d === 'object' && d !== null ? d : {};
}

/**
 * @param {object} rule
 */
function normalizeFrequency(rule) {
  const f = String(rule.frequency ?? '').toLowerCase();
  if (f === 'weekly') return 'weekly';
  if (f === 'monthly') return 'monthly';
  if (f === 'yearly' || f === 'annually') return 'yearly';
  return f;
}

/**
 * @param {object} schedule
 */
function getMonthlyScheduleAmount(schedule) {
  const amount = Math.abs(Number(schedule.amount)) / 100;
  const rule = parseScheduleDateRule(schedule);
  const freq = normalizeFrequency(rule);
  const interval = Number(rule.interval ?? 1);
  if (freq === 'weekly') return amount * 4.33;
  if (freq === 'monthly' && interval === 1) return amount;
  if (freq === 'monthly' && interval === 6) return amount / 6;
  if (freq === 'monthly' && interval === 3) return amount / 3;
  if (freq === 'yearly') return amount / 12;
  return amount;
}

/**
 * @param {object} schedule
 */
function lumpScheduleAmount(schedule) {
  return Math.abs(Number(schedule.amount)) / 100;
}

/**
 * Resolve display name from Actual payees list (not transaction history).
 * @param {{ payee?: string, name?: string }} schedule
 * @param {{ id: string, name: string }[]} payees
 */
function resolvePayeeName(schedule, payees) {
  const id = schedule.payee;
  if (id != null && id !== '') {
    const p = payees.find((x) => x.id === id || String(x.id) === String(id));
    if (p?.name) return p.name;
  }
  const n = String(schedule.name ?? '').trim();
  if (n) return n;
  return id != null ? String(id) : 'Scheduled';
}

/**
 * @param {object} rule
 */
function frequencyDisplay(rule) {
  const freq = normalizeFrequency(rule);
  const interval = Number(rule.interval ?? 1);
  if (freq === 'weekly') return 'weekly';
  if (freq === 'monthly' && interval === 6) return 'every 6 months';
  if (freq === 'monthly' && interval === 3) return 'every 3 months';
  if (freq === 'monthly') return 'monthly';
  if (freq === 'yearly') return 'yearly';
  return freq || 'scheduled';
}

/**
 * @param {object} rule
 */
function scheduleBucket(rule) {
  const freq = normalizeFrequency(rule);
  const interval = Number(rule.interval ?? 1);
  if (freq === 'weekly') return 'weekly';
  if (freq === 'monthly' && interval === 6) return 'semiannual';
  if (freq === 'monthly') return 'monthly';
  if (freq === 'yearly') return 'yearly';
  return 'other';
}

/**
 * @param {object[]} schedules
 * @param {{ id: string, name: string }[]} payees
 * @param {Date} now
 */
function buildScheduleContext(schedules, payees, now) {
  /** @type {{ name: string, monthly: number, frequency: string, next: string, note?: string, bucket: string, perPeriod: number, isIncome: boolean }[]} */
  const lines = [];
  let monthlyIncome = 0;
  let totalExpenseCommitted = 0;

  const cutoff30 = new Date(now);
  cutoff30.setDate(cutoff30.getDate() + 30);

  /** @type {object[]} */
  const upcomingThisMonth = [];
  /** @type {object[]} */
  const upcomingNext30Days = [];

  for (const s of schedules) {
    if (s.completed) continue;
    const amt = Number(s.amount);
    const monthly = getMonthlyScheduleAmount(s);
    const rule = parseScheduleDateRule(s);
    const label = resolvePayeeName(s, payees);
    const freqLabel = frequencyDisplay(rule);
    const bucket = scheduleBucket(rule);
    const next = String(s.next_date || '').slice(0, 10);
    const perPeriod = lumpScheduleAmount(s);
    let note;
    if (normalizeFrequency(rule) === 'monthly' && Number(rule.interval ?? 1) === 6) {
      note = `budget $${monthly.toFixed(2)}/mo to cover lump sum of $${perPeriod.toFixed(2)}`;
    }

    if (amt > 0) {
      monthlyIncome += monthly;
      lines.push({
        name: label,
        monthly,
        frequency: freqLabel,
        next,
        note,
        bucket,
        perPeriod,
        isIncome: true,
      });
    } else {
      totalExpenseCommitted += monthly;
      lines.push({
        name: label,
        monthly,
        frequency: freqLabel,
        next,
        note,
        bucket,
        perPeriod,
        isIncome: false,
      });
    }

    if (next) {
      const nd = new Date(`${next}T12:00:00`);
      if (!Number.isNaN(nd.getTime())) {
        const startM = new Date(now.getFullYear(), now.getMonth(), 1);
        const endM = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        if (nd >= startM && nd <= endM) upcomingThisMonth.push(s);
        if (nd >= now && nd <= cutoff30) upcomingNext30Days.push(s);
      }
    }
  }

  const monthlyExpenses = lines.filter((x) => !x.isIncome);
  const incomeRows = lines.filter((x) => x.isIncome);
  const freeCashFlow = monthlyIncome - totalExpenseCommitted;

  return {
    monthlyIncome,
    monthlyExpenses,
    incomeRows,
    upcomingThisMonth,
    upcomingNext30Days,
    totalExpenseCommitted,
    freeCashFlow,
    lines,
  };
}

/**
 * @param {object[]} schedules
 * @param {{ id: string, name: string }[]} payees
 * @param {Date} now
 */
function buildCarInsuranceSinkingFundPromptParagraph(schedules, payees, now) {
  for (const s of schedules) {
    if (s.completed) continue;
    const label = resolvePayeeName(s, payees);
    if (!/insurance/i.test(label)) continue;
    const rule = parseScheduleDateRule(s);
    const freq = normalizeFrequency(rule);
    const interval = Number(rule.interval ?? 1);
    const lump = lumpScheduleAmount(s);
    const next = String(s.next_date || '').slice(0, 10);
    if (!(freq === 'monthly' && interval === 6) && freq !== 'yearly') continue;
    const nd = new Date(`${next}T12:00:00`);
    if (Number.isNaN(nd.getTime())) continue;
    const monthsUntil = Math.max(1, Math.ceil((nd.getTime() - now.getTime()) / (86400000 * 30)));
    const setAside = lump / monthsUntil;
    const rounded = Math.ceil(setAside);
    const dueStr = nd.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const dueMonth = nd.toLocaleDateString('en-US', { month: 'long' });
    return `SINKING FUND REQUIRED:
 Car Insurance: $${lump.toFixed(0)} due ${dueStr} (${monthsUntil} months away)
 Must set aside $${setAside.toFixed(2)}/month starting now to be ready
 Add 'Car Insurance' as a budget line at $${rounded}/month
 This is NOT currently in the budget and will cause a shortfall in ${dueMonth}`;
  }
  return '';
}

/**
 * @param {{ stat: object, suggested: number }[]} rows
 */
function sumVariableSuggestedBudget(rows) {
  let s = 0;
  for (const r of rows) {
    if (matchFixedExpenseBucket(r.stat.name)) continue;
    if (shouldExcludeBudgetCategoryName(r.stat.name)) continue;
    if (isSavingsCategoryName(r.stat.name)) continue;
    s += r.suggested;
  }
  return s;
}

/**
 * @param {ReturnType<typeof buildScheduleContext>} ctx
 * @param {{ stat: object, suggested: number }[]} rows
 */
function printVariableBudgetFreeCashWarning(ctx, rows) {
  if (!rows?.length) return;
  const fcf = ctx.freeCashFlow;
  if (!Number.isFinite(fcf) || fcf <= 0.005) return;
  const varSum = sumVariableSuggestedBudget(rows);
  if (varSum <= fcf + 0.5) return;
  const overBy = varSum - fcf;
  /** @type {{ name: string, suggested: number }[]} */
  const vars = [];
  for (const r of rows) {
    if (matchFixedExpenseBucket(r.stat.name)) continue;
    if (shouldExcludeBudgetCategoryName(r.stat.name)) continue;
    if (isSavingsCategoryName(r.stat.name)) continue;
    vars.push({ name: r.stat.name, suggested: r.suggested });
  }
  vars.sort((a, b) => b.suggested - a.suggested);
  const lever = vars[0];
  if (!lever) return;
  const newAmt = Math.max(0, lever.suggested - overBy);
  console.warn(
    `WARNING: Variable budget ($${varSum.toFixed(0)}) exceeds free cash flow ($${fcf.toFixed(0)})`,
  );
  console.warn(
    ` Reduce by $${overBy.toFixed(0)} to avoid drawing down savings beyond scheduled amount`,
  );
  console.warn(
    ` Biggest lever: ${lever.name} ($${lever.suggested.toFixed(0)}) — reduce to $${newAmt.toFixed(0)} to balance`,
  );
  console.warn('');
}

/**
 * @param {ReturnType<typeof buildScheduleContext>} ctx
 * @param {object[]} schedules
 * @param {{ id: string, name: string }[]} payees
 * @param {Date} now
 */
function buildSchedulePromptSection(ctx, schedules, payees, now) {
  if (!ctx.monthlyIncome && !ctx.monthlyExpenses.length) return '';

  const incomeLines = ctx.incomeRows.map((r) => {
    if (r.bucket === 'weekly') {
      return `  ${r.name}: +$${r.perPeriod.toFixed(2)}/week = +$${r.monthly.toFixed(2)}/month${r.next ? ` (next: ${r.next})` : ''}`;
    }
    return `  ${r.name}: +$${r.monthly.toFixed(2)}/month${r.next ? ` (next: ${r.next})` : ''}`;
  });

  const expenseLines = ctx.monthlyExpenses.map((e) => {
    const nx = e.next ? ` (next: ${e.next})` : '';
    const nt = e.note ? ` — ${e.note}` : '';
    return `  ${e.name}: -$${e.monthly.toFixed(2)}/month${nx}${nt}`;
  });

  const billsFloor = ctx.monthlyExpenses
    .filter((e) =>
      /loan|education|t-mobile|tmobile|department|phone bill|^phone$/i.test(e.name),
    )
    .reduce((s, e) => s + e.monthly, 0);

  const carIns = ctx.monthlyExpenses.find((e) => /insurance/i.test(e.name));

  /** @type {string[]} */
  const rules = [];
  if (billsFloor > 0.005) {
    rules.push(
      `1. Bills must be at least $${billsFloor.toFixed(2)} (scheduled loan / phone-type bills)`,
    );
  }
  if (carIns) {
    rules.push(
      `2. Car Insurance needs ~$${carIns.monthly.toFixed(2)}/month set aside — suggest adding an 'Insurance' or 'Car Insurance' budget line`,
    );
  }
  rules.push(
    `3. Variable spending (dining, shopping, groceries, etc.) must fit within ~$${Math.max(0, ctx.freeCashFlow).toFixed(2)}/month after fixed scheduled items`,
  );

  const savingsAutoLine = ctx.lines.find((l) => !l.isIncome && /savings/i.test(l.name));
  let criticalSavings = '';
  if (savingsAutoLine && savingsAutoLine.monthly > 0.005) {
    const autoDetail =
      savingsAutoLine.bucket === 'weekly'
        ? `$${savingsAutoLine.perPeriod.toFixed(2)}/week is transferred automatically to savings ($${savingsAutoLine.monthly.toFixed(2)}/month)`
        : `$${savingsAutoLine.monthly.toFixed(2)}/month is transferred automatically to savings`;
    criticalSavings = `
CRITICAL — Savings is already fully automated:
 ${autoDetail}
 This is a committed expense like a bill — do not suggest reducing it.
 Do NOT suggest a Savings budget line — it is handled by the schedule.
 The savings rate shown reflects this automated transfer.
`;
  }

  const sinkFundPrompt = buildCarInsuranceSinkingFundPromptParagraph(schedules, payees, now);

  return `=== SCHEDULED TRANSACTIONS ===
Your Actual Budget has these recurring commitments:

Monthly income scheduled:
${ctx.incomeRows.length ? incomeLines.join('\n') : '  (none detected)'}

Monthly expenses scheduled:
${ctx.monthlyExpenses.length ? expenseLines.join('\n') : '  (none detected)'}

Total scheduled expenses: $${ctx.totalExpenseCommitted.toFixed(2)}/month
Remaining for variable spending: $${ctx.monthlyIncome.toFixed(2)} − $${ctx.totalExpenseCommitted.toFixed(2)} = $${Math.max(0, ctx.freeCashFlow).toFixed(2)}/month
${criticalSavings}${sinkFundPrompt ? `\n${sinkFundPrompt}\n` : ''}
IMPORTANT BUDGET RULES based on schedules:
${rules.join('\n')}
`;
}

/**
 * @param {ReturnType<typeof buildScheduleContext>} ctx
 */
function formatScheduledTransactionsConsole(ctx) {
  if (!ctx.lines.length) {
    return ['--- Scheduled Transactions ---', '  (none)', ''];
  }
  const fmtDay = (iso) => {
    if (!iso) return '';
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const weekly = ctx.lines.filter((x) => x.bucket === 'weekly');
  const monthly = ctx.lines.filter((x) => x.bucket === 'monthly');
  const semiannual = ctx.lines.filter((x) => x.bucket === 'semiannual');
  const yearly = ctx.lines.filter((x) => x.bucket === 'yearly');
  const other = ctx.lines.filter((x) => x.bucket === 'other');

  /** @type {string[]} */
  const out = ['--- Scheduled Transactions ---'];

  const pushGroup = (title, rows) => {
    if (!rows.length) return;
    out.push(`  ${title}`);
    for (const r of rows) {
      const sign = r.isIncome ? '+' : '−';
      const next = r.next ? `  (next: ${fmtDay(r.next)})` : '';
      if (r.bucket === 'weekly') {
        out.push(
          `    ${`${r.name}:`.padEnd(22)} ${sign}$${r.perPeriod.toFixed(2)}/wk  = ${sign}$${r.monthly.toFixed(2)}/mo${next}`,
        );
      } else if (r.bucket === 'semiannual') {
        out.push(
          `    ${`${r.name}:`.padEnd(22)} ${sign}$${r.perPeriod.toFixed(2)} / 6 mo  = ${sign}$${r.monthly.toFixed(2)}/mo${next}`,
        );
      } else {
        out.push(
          `    ${`${r.name}:`.padEnd(22)} ${sign}$${r.monthly.toFixed(2)}/mo${next}`,
        );
      }
    }
    out.push('');
  };

  pushGroup('Weekly:', weekly);
  pushGroup('Monthly:', monthly);
  pushGroup('Every 6 months:', semiannual);
  pushGroup('Yearly:', yearly);
  pushGroup('Other:', other);

  out.push(`  Total committed:    −$${ctx.totalExpenseCommitted.toFixed(2)}/month`);
  out.push(
    `  Free cash flow:     ${ctx.freeCashFlow >= 0 ? '+' : ''}$${ctx.freeCashFlow.toFixed(2)}/month (income minus committed)`,
  );
  out.push('');
  return out;
}

/**
 * @param {object[]} schedules
 * @param {{ id: string, name: string }[]} payees
 * @param {Date} now
 */
function buildCarInsuranceSinkingFundMd(schedules, payees, now) {
  /** @type {string[]} */
  const blocks = [];
  for (const s of schedules) {
    if (s.completed) continue;
    const label = resolvePayeeName(s, payees);
    if (!/insurance/i.test(label)) continue;
    const rule = parseScheduleDateRule(s);
    const freq = normalizeFrequency(rule);
    const interval = Number(rule.interval ?? 1);
    const lump = lumpScheduleAmount(s);
    const next = String(s.next_date || '').slice(0, 10);
    if (!(freq === 'monthly' && interval === 6) && freq !== 'yearly') continue;
    const nd = new Date(`${next}T12:00:00`);
    if (Number.isNaN(nd.getTime())) continue;
    const monthsUntil = Math.max(1, Math.ceil((nd.getTime() - now.getTime()) / (86400000 * 30)));
    const setAside = lump / monthsUntil;
    const rounded = Math.ceil(setAside);
    const dueStr = nd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    blocks.push(
      `**SINKING FUND NEEDED:**\n` +
        `  ${label}: $${lump.toFixed(0)} due ${dueStr}\n` +
        `  Months until due: ${monthsUntil}\n` +
        `  Set aside per month: $${setAside.toFixed(2)} (to be ready by ${dueStr})\n` +
        `  Recommended: Add 'Car Insurance' budget line at $${rounded}/month\n`,
    );
  }
  return blocks.join('\n');
}

/**
 * @param {{ stat: object, suggested: number }[]} rows
 * @param {{ mode?: 'default' | 'off', offMonthlyIncome?: number }} [opts]
 */
function markdownSuggestedBudgetTable(rows, opts = {}) {
  const mode = opts.mode ?? 'default';
  const offMonthlyIncome = opts.offMonthlyIncome ?? 0;
  const expenseRows = rows.filter(
    (r) => !isSavingsCategoryName(r.stat.name) && r.stat.monthlyAvg > 0.5,
  );
  const expenseDenom = expenseRows.length || rows.filter((r) => !isSavingsCategoryName(r.stat.name)).length || 1;
  const naiveShare = offMonthlyIncome > 0 ? offMonthlyIncome / expenseDenom : 0;

  let md =
    '| Category | Current Avg | Suggested Budget | Change |\n|----------|-------------|-----------------|--------|\n';
  for (const row of rows) {
    const c = row.stat;
    const suggested = row.suggested;
    let changeStr = formatChangeColumn(c.monthlyAvg, suggested, c.trend);
    if (mode === 'off') {
      if (isSavingsCategoryName(c.name)) {
        changeStr = `${changeStr} · draw down (not contribute)`;
      } else if (
        naiveShare > 0 &&
        suggested > naiveShare + 0.01 &&
        suggested > offMonthlyIncome * 0.12
      ) {
        changeStr = `${changeStr} ⚠️ vs off income split`;
      }
    }
    md += `| ${c.name} | $${c.monthlyAvg.toFixed(0)} | $${suggested} | ${changeStr} |\n`;
  }
  return md;
}

async function main() {
  const argv = process.argv.slice(2);
  const { months: nMonths, export: exportFlag } = parseArgs(argv);
  const monthKeys = lastNCalendarMonthKeys(nMonths);
  const monthSet = new Set(monthKeys);

  const { monthsForAvg, excludedPartialYm, partialNote } =
    resolveMonthsForAverages(monthKeys);
  const avgSet = new Set(monthsForAvg);

  await connect();
  const payees = await getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));

  /** @type {object[]} */
  let schedules = [];
  try {
    schedules = await getSchedules();
  } catch (e) {
    console.warn('⚠ Could not load schedules:', e.message);
  }
  const nowDate = new Date();
  const scheduleContext = buildScheduleContext(schedules, payees, nowDate);
  const schedulePromptSection = buildSchedulePromptSection(
    scheduleContext,
    schedules,
    payees,
    nowDate,
  );

  const categories = await getCategories();
  const catIdToName = new Map(categories.map((c) => [c.id, c.name]));

  const accounts = await getAccounts();
  const balanceSnapshot = resolveBalanceSnapshot(accounts);
  const totalSavings = balanceSnapshot.totalSavings;

  console.log('');
  console.log('Savings accounts found:');
  if (balanceSnapshot.useEnv) {
    const sav = balanceSnapshot.rows[1];
    console.log(
      `  ${sav.label} (${sav.suffix}): ${formatUsdAmount(sav.balance)} (from .env ACCOUNT_BALANCE_CHASE_SAVINGS)`,
    );
    console.log(`  Total: ${formatUsdAmount(totalSavings)}`);
  } else if (!balanceSnapshot.savingsAccounts.length) {
    console.log('  (none — no account name containing "savings"; balance treated as $0.00)');
    console.log(`  Total: ${formatUsdAmount(totalSavings)}`);
  } else {
    for (const a of balanceSnapshot.savingsAccounts) {
      const bal = Number(a.balance ?? 0) / 100;
      console.log(`  ${a.name} (${accountDisplaySuffix(a)}): $${bal.toFixed(2)}`);
    }
    console.log(`  Total: ${formatUsdAmount(totalSavings)}`);
  }

  /** @type {object[]} */
  const allTxs = [];
  for (const acc of accounts) {
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    allTxs.push(...txs);
  }

  await disconnect();

  const { byCatMonth, byMonth, txInWindow } = buildMonthlyRollups(
    allTxs,
    monthSet,
    catIdToName,
  );

  const monthsWithData = monthKeys.filter((ym) => {
    const inc = monthlyIncomeFromTxs(allTxs, ym);
    const r = byMonth.get(ym);
    return r && (inc > 0 || r.expenses > 0);
  });

  if (monthsWithData.length < 2) {
    console.warn(
      `⚠ Only ${monthsWithData.length} month(s) with income/expense activity in the selected window. Results will be rough — aim for at least 2 full months of data.\n`,
    );
  }

  const categoryStats = buildCategoryStats(byCatMonth, monthKeys, avgSet);

  const billsCatId = findBillsCategoryId(catIdToName);
  const diningCatId = findDiningCategoryId(catIdToName);
  const billsBreakdown = buildBillsPayeeBreakdown(
    allTxs,
    billsCatId,
    monthSet,
    payeeById,
  );
  const billsSplit = buildBillsSplitAnalysis(
    allTxs,
    billsCatId,
    monthSet,
    monthsForAvg,
    payeeById,
  );
  const diningMeta = buildDiningMerchantStats(
    allTxs,
    diningCatId,
    monthSet,
    payeeById,
  );

  const reversalDeductionMap = computeReversalDeductionByCatMonth(allTxs, monthKeys, catIdToName);
  const spikes = detectSpikes(categoryStats, excludedPartialYm, reversalDeductionMap);
  const spikesText = formatSpikesPrompt(spikes);
  const stability = computeIncomeStability(allTxs, monthsForAvg, payeeById);

  const overall = overallStatsFromMonths(byMonth, allTxs, monthsForAvg, categoryStats);

  const seasonalEnv = readSeasonalEnv();
  const now = new Date();
  const monthlyIncomes = monthsForAvg.map((ym) => ({
    month: ym,
    income: monthlyIncomeFromTxs(allTxs, ym),
  }));
  const cs = splitCalendarSeasonalIncome(monthlyIncomes);
  const peakEnvSet =
    Boolean(process.env.PEAK_SEASON_START?.trim()) &&
    Boolean(process.env.PEAK_SEASON_END?.trim());
  const inPeakNow = dateInPeakSeasonRange(now, seasonalEnv.peakStart, seasonalEnv.peakEnd);

  let seasonalReady = false;
  if (peakEnvSet) {
    seasonalReady =
      (cs.peakCount >= 1 && cs.offCount >= 1) ||
      (!inPeakNow && cs.peakCount >= 1);
  } else {
    seasonalReady = cs.peakCount >= 1 && cs.offCount >= 1;
  }

  let peakMonthlyIncome = peakMonthlyIncomeFromPeakMonths(monthlyIncomes);
  if (peakMonthlyIncome < 0.005 && cs.peakCount >= 1) peakMonthlyIncome = cs.peakMonthlyIncome;
  if (peakMonthlyIncome < 0.005) peakMonthlyIncome = overall.avgMonthlyIncome;

  let offMonthlyIncome = cs.offCount >= 1 ? cs.offMonthlyIncome : overall.avgMonthlyIncome;
  let offIncomeLabel = '';

  const envOffRaw = process.env.OFF_SEASON_MONTHLY_INCOME?.trim();
  const envOffNum =
    envOffRaw !== undefined && envOffRaw !== ''
      ? Number.parseFloat(envOffRaw)
      : NaN;

  if (seasonalReady && Number.isFinite(envOffNum) && envOffNum >= 0) {
    offMonthlyIncome = envOffNum;
    offIncomeLabel = '(from .env OFF_SEASON_MONTHLY_INCOME)';
  } else if (seasonalReady && cs.offCount < 1) {
    const est = estimateOffSeasonMonthlyIncomeFromDeposits(allTxs, seasonalEnv.peakEnd);
    if (est.monthly > 0.005) {
      offMonthlyIncome = est.monthly;
    } else {
      offMonthlyIncome = overall.avgMonthlyIncome;
    }
    offIncomeLabel =
      '(estimated — set OFF_SEASON_MONTHLY_INCOME in .env for accuracy)';
  }

  const currentSeason = getCurrentSeasonLabel(now, seasonalEnv.peakStart, seasonalEnv.peakEnd);
  const incomeExpenseGap = Math.max(0, overall.avgMonthlyExpenses - offMonthlyIncome);
  const seasonalSavingsTarget = incomeExpenseGap * seasonalEnv.offSeasonMonths;

  const billsCategoryMoAvg = getBillsCategoryAvg(categoryStats);
  const suggestedPlan = buildSuggestedPlan(
    categoryStats,
    diningMeta,
    billsSplit,
    billsCatId,
  );

  const incBase = Math.max(overall.avgMonthlyIncome, 0.01);
  /** @type {{ stat: object, suggested: number }[] | null} */
  let peakBudgetRows = null;
  /** @type {{ stat: object, suggested: number }[] | null} */
  let offBudgetRows = null;
  let offSeasonMonthlyBurn = 0;
  let monthlyNetBurn = 0;
  /** @type {number} */
  let runwayAgainstBurn = Number.POSITIVE_INFINITY;
  let seasonalPromptBlock = '';
  if (seasonalReady) {
    const pk = peakMonthlyIncome / incBase;
    const offF = offMonthlyIncome / incBase;
    peakBudgetRows = scaleSuggestedPlanRows(suggestedPlan.rows, pk, pk * 1.12);
    offBudgetRows = scaleSuggestedPlanRows(suggestedPlan.rows, offF, offF * 0.55);
    offSeasonMonthlyBurn = offBudgetRows ? sumSuggestedBudget(offBudgetRows) : 0;
    monthlyNetBurn = Math.max(0, offSeasonMonthlyBurn - offMonthlyIncome);
    if (monthlyNetBurn > 0.005) {
      runwayAgainstBurn = totalSavings / monthlyNetBurn;
    } else {
      runwayAgainstBurn = Number.POSITIVE_INFINITY;
    }
    seasonalPromptBlock = buildTaxSeasonalContextPromptBlock(
      {
        peakMonthlyIncome,
        offMonthlyIncome,
        offIncomeLabel,
        currentSeason,
        totalSavings,
        seasonalSavingsTarget,
        offSeasonMonthlyBurn,
        runwayMonthsBudgetBased: runwayAgainstBurn,
        savingsBalanceSource: balanceSnapshot.savingsBalanceSource,
      },
      overall,
      seasonalEnv,
    );
  }

  const variableBudgetRowsForWarning =
    seasonalReady && offBudgetRows?.length ? offBudgetRows : suggestedPlan.rows;
  printVariableBudgetFreeCashWarning(scheduleContext, variableBudgetRowsForWarning);

  const showSimplifiedRunway =
    !seasonalReady &&
    Boolean(process.env.PEAK_SEASON_END?.trim()) &&
    totalSavings > 0.005 &&
    !inPeakNow;

  const fixedVarPartition = seasonalReady
    ? partitionOffSeasonFixedVariable(categoryStats)
    : null;
  const offSeasonFixedVariableBlock =
    seasonalReady && fixedVarPartition
      ? buildOffSeasonFixedVariablePrompt(fixedVarPartition, offMonthlyIncome)
      : '';

  const exactSuggestedInject =
    seasonalReady && peakBudgetRows && offBudgetRows && fixedVarPartition
      ? `PEAK SEASON (${seasonalEnv.peakStart}–${seasonalEnv.peakEnd}) — amounts MUST match this table:\n${formatExactSuggestedInject(
          peakBudgetRows,
        )}\n\nOFF SEASON — Do NOT proportionally scale every category to income. Follow the FIXED vs VARIABLE rules above: keep fixed buckets near their historical averages; allocate only "Available for variable" across discretionary categories (prioritize cuts to Dining Out, Shopping, Entertainment before touching fixed buckets).\n\nVariable categories from this person's data (flexible pool): ${fixedVarPartition.variableNames.join(
          ', ',
        )}\n\nAfter writing your response, the SUM of every suggested monthly dollar amount in your **Off Season** markdown table is their true monthly burn — list each category row so amounts can be totaled.\n\n(Do not use a single multiplier across all categories for off-season.)`
      : formatExactSuggestedInject(suggestedPlan.rows);

  const utilitiesCritical = buildUtilitiesCriticalPrompt(categoryStats, spikes);
  const savingsContextBlock = buildSavingsContextPrompt(byMonth, monthsForAvg, overall);
  const diningLeverBlock = buildDiningLeverPrompt(suggestedPlan.diningStat, diningMeta);

  const billsSplitPrompt = billsCatId
    ? `Bills category breakdown:
  True bills (loans, services, keywords, named payees): ~$${billsSplit.trueMoAvg.toFixed(
      2,
    )}/mo avg across months used for averages
  Other Bills payees (unclassified): ~$${billsSplit.otherMoAvg.toFixed(2)}/mo avg
  Suspected credit card payments / transfers: ~$${billsSplit.transferMoAvg.toFixed(
      2,
    )}/mo avg
  Full Bills category average (all payees): ~$${billsCategoryMoAvg.toFixed(2)}/mo — inflated by transfers.
  True recurring bills (excluding suspected transfers) are approximately ~$${(
    billsSplit.trueMoAvg + billsSplit.otherMoAvg
  ).toFixed(2)}/mo avg.
  NOTE: Do NOT suggest reducing credit card payment transfers — they pay down card balances, not discretionary spending.
  Do NOT treat Chase Credit Card / Payment-style payees as cuts — flag them as transfers to re-categorize.`
    : '(no Bills category)';

  if (overall.savingsRateWarn) {
    console.warn(
      '⚠ Savings rate sign unexpected after normalization — showing N/A. Check Savings-category transfers in Actual.\n',
    );
  }

  const savingsRateLine =
    overall.savingsRateNumeric != null && overall.avgMonthlyIncome > 0
      ? `${overall.savingsRateNumeric.toFixed(1)}%`
      : 'N/A';

  const categoryBreakdown =
    categoryStats.length > 0
      ? formatCategoryBreakdown(categoryStats, avgSet)
      : '(no categorized expense activity in this window)';

  const incomeSourcesBlock = buildIncomeSourceLines(allTxs, monthSet, payeeById);
  const spendPatternBlock = formatOneTimeAndRecurringBlocks(categoryStats, monthKeys);
  const reductionBlock = buildReductionTargetsBlock(categoryStats, diningMeta);

  const billsJumpLine =
    billsBreakdown.marchTotal > 100 && billsBreakdown.aprilTotal > 100
      ? `Bills category totals (all payees): March ~$${billsBreakdown.marchTotal.toFixed(
          0,
        )} → April ~$${billsBreakdown.aprilTotal.toFixed(0)}.`
      : '';

  const diningVisitLine =
    diningMeta.sortedTop && diningMeta.sortedTop.length >= 2
      ? `Top dining merchants by spend: ${diningMeta.sortedTop
          .map(([n, v]) => `${n} (${v.visits} visits, $${v.dollars.toFixed(0)})`)
          .slice(0, 3)
          .join('; ')}.`
      : '';

  const partialMonthPrompt =
    excludedPartialYm != null
      ? `${ymDisplayLabel(excludedPartialYm)} is partial — do NOT use it to conclude spending dropped or improved.`
      : '(no partial month excluded from averages)';

  const utilitiesSpike = spikes.find((s) => /utilities/i.test(s.category));

  const prompt = `
${utilitiesCritical ? `${utilitiesCritical}\n\n` : ''}You are a personal finance advisor helping someone build a realistic monthly budget.
Based on their ACTUAL spending history below, suggest a budget they can realistically 
stick to — not an ideal budget, a REALISTIC one that acknowledges their habits.

=== SPENDING HISTORY (${overall.monthsAnalyzed} full months in averages; raw window may include partial current month) ===

Monthly Income (avg over months used): $${overall.avgMonthlyIncome.toFixed(2)}
Monthly Expenses (avg): $${overall.avgMonthlyExpenses.toFixed(2)}  
Current Savings Rate (money moved to Savings categories as % of income): ${savingsRateLine}

${partialNote ? `Note: ${partialNote}` : ''}

${savingsContextBlock}

${schedulePromptSection}

Income stability:
${stability.stabilityBlock}

${seasonalPromptBlock ? `${seasonalPromptBlock}\n` : ''}
${offSeasonFixedVariableBlock ? `${offSeasonFixedVariableBlock}\n` : ''}
Income sources (all positive inflows in window):
${incomeSourcesBlock}

Category breakdown (monthly averages use complete months only when partial month excluded):
${categoryBreakdown}

${spendPatternBlock}

IMPORTANT ANOMALIES TO CALL OUT:
${spikesText}

${utilitiesSpike && !utilitiesCritical ? `Most urgent utility anomaly: ${utilitiesSpike.category} hit $${utilitiesSpike.spikeAmount.toFixed(0)} in ${ymDisplayLabel(utilitiesSpike.spikeMonth)} vs ~$${utilitiesSpike.normalAvg.toFixed(0)} typical — investigate usage, billing true-ups, or mis-categorized bills.` : ''}

Dining detail (for grounded advice):
${diningMeta.topLines}
${diningVisitLine}
${diningMeta.pairLine ? `\n${diningMeta.pairLine}` : ''}

${diningLeverBlock ? `\n${diningLeverBlock}\n` : ''}

${billsSplitPrompt}

Bills breakdown by payee (all Bills outflows, full window — before split):
${billsBreakdown.lines}
${billsJumpLine ? `\n${billsJumpLine}` : ''}

${reductionBlock}

Trend analysis:
- Fastest growing (recurring/seasonal): ${overall.fastestGrowingCategory || '(n/a)'}
- Most volatile (recurring/seasonal): ${overall.mostVolatileCategory || '(n/a)'}  
- Biggest expense (recurring/seasonal): ${overall.biggestExpenseCategory || '(n/a)'}

IMPORTANT: Give advice specific to THIS person's data.
- Do NOT mention generic apps like Ibotta or Rakuten unless they 
  already appear in the transaction data
- DO reference specific merchants from their data by name
- DO reference specific dollar amounts from their history
- The person lives in the West Covina, CA area — advice should 
  be relevant to Southern California
- If dining out is high, mention specific merchants by name
- If a category spiked one month, call it out specifically

Do NOT suggest a monthly budget for one-time categories.
Instead mention them as irregular expenses to plan for separately.

RULES FOR YOUR RESPONSE:
1. Never suggest a flat percentage cut across all categories
2. Each category must have a DIFFERENT recommended change based on its pattern
3. For Dining Out / dining categories: cite frequent merchants with visit counts when present (e.g. Jack in the Box, Troys Burgers) — large visit counts imply habit spending that compounds
4. The savings rate shown is POSITIVE when money is flowing into Savings categories — describe it as money saved/transferred to savings, not as negative cash flow
5. ${partialMonthPrompt}
6. Call out utility spikes (if any above) as urgent to investigate vs normal bills
7. Savings acknowledgment: this person is transferring ~$${overall.avgMonthlySavings.toFixed(
    0,
  )}/mo on average into Savings-named categories — acknowledge if that is strong relative to income
${
  seasonalReady
    ? `8. Seasonal income: include two labeled perspectives — **Peak Season (${seasonalEnv.peakStart}–${seasonalEnv.peakEnd})** and **Off Season (${seasonalEnv.peakEnd}–Dec)**. Peak dollar amounts MUST match the PEAK table below. Off-season: obey FIXED vs VARIABLE rules above — do NOT multiply every category by the same factor; fixed costs stay near baseline averages.
9. Discuss the seasonal savings target vs tax-season savings banked using the figures in the seasonal block above; flag CRITICAL if expenses exceed off-season income.
`
    : ''
}
IMPORTANT: ${seasonalReady ? `Peak season amounts MUST match the PEAK table below. Off-season: build category amounts using FIXED vs VARIABLE rules (not proportional scaling). Include a markdown **Off Season** budget table whose rows sum to the true monthly burn.` : `The numbers in your narrative MUST exactly match the following suggested monthly amounts (these are precomputed and will match the budget table):`}
${exactSuggestedInject}

${seasonalReady ? `Do not invent different dollar amounts in prose vs the PEAK table; off-season rows must be consistent with fixed/variable logic.` : `Do not invent different dollar amounts in prose vs tables.`}

=== YOUR TASK ===

${
  seasonalReady
    ? `Seasonal income detected: provide **Peak Season** and **Off Season** budget sections with exact figures from the tables; treat OFF-SEASON amounts as what they should plan to live on month-to-month.\n\n`
    : ''
}Generate a personalized monthly budget with these sections:

1. BUDGET SUMMARY
${seasonalReady ? `   - Separate peak-season vs off-season monthly narrative (exact $ from tables)\n` : ''}   - Suggested monthly budget per category (be realistic, not aspirational)
   - Recommended savings target
   - Explain the 50/30/20 or other framework if it applies

2. CATEGORY BUDGETS
   For each spending category suggest:
   - Recommended monthly budget amount
   - Whether to reduce / maintain / allow growth
   - One specific tactic to hit that number
   Format as a simple table.

3. SAVINGS STRATEGY  
   - Current savings rate vs recommended
   - Specific dollar target for emergency fund if not mentioned
   - One realistic way to increase savings by 5% based on their spending

4. REALISTIC WINS
   - 3 specific changes they could make based on their actual spending
   - Each win should reference real merchants or categories from their data
   - Make them small and achievable, not dramatic

5. 3-MONTH GOAL
   - One specific measurable goal for the next 3 months
   - Based on their biggest opportunity area

Tone: honest and direct like a good financial advisor, not preachy.
Be specific with dollar amounts. Reference actual merchants and patterns.
Total length: 500-600 words.
`.trim();

  /** @type {string | null} */
  let narrative = null;
  try {
    narrative = (await ollamaGenerate(prompt)).trim();
  } catch (e) {
    console.error('✗ Could not reach Ollama at', config.OLLAMA_URL);
    console.error('  Model:', config.OLLAMA_MODEL);
    console.error('  Error:', e.message);
    console.error('  Printing raw data tables only.\n');
  }

  if (seasonalReady && narrative) {
    const fixedTotal = OFF_SEASON_FIXED_FLOOR_TOTAL;
    const scaledVariableTotal = sumScaledVariableOffBudget(offBudgetRows);

    let burn = parseOffSeasonBurnFromResponse(narrative);
    if (burn != null && Number.isFinite(burn) && burn < fixedTotal) {
      burn = fixedTotal + scaledVariableTotal;
    } else if (burn == null && offBudgetRows?.length) {
      burn = sumSuggestedBudget(offBudgetRows);
    }
    if (burn != null && Number.isFinite(burn) && burn >= 0) {
      offSeasonMonthlyBurn = burn;
      monthlyNetBurn = Math.max(0, offSeasonMonthlyBurn - offMonthlyIncome);
      if (monthlyNetBurn > 0.005) {
        runwayAgainstBurn = totalSavings / monthlyNetBurn;
      } else {
        runwayAgainstBurn = Number.POSITIVE_INFINITY;
      }
    }
  }

  console.log('');
  console.log('============================================');
  console.log('  Budget Ideation Report');
  console.log(`  Based on ${overall.monthsAnalyzed} month(s) in averages`);
  if (partialNote) console.log(`  ${partialNote}`);
  console.log('============================================');
  console.log('');

  if (narrative) {
    console.log(narrative);
  } else {
    console.log('(Ollama narrative unavailable — see raw data below.)');
  }

  const billsInvestigationMd = buildBillsInvestigationMd(
    billsSplit,
    billsCategoryMoAvg,
    billsCatId,
  );
  if (billsInvestigationMd) {
    console.log('');
    console.log(billsInvestigationMd);
    console.log('');
  }

  console.log('');
  console.log('============================================');
  console.log('  Raw Data Summary');
  console.log(`  Income avg:   $${overall.avgMonthlyIncome.toFixed(2)}/mo`);
  console.log(`  Expense avg:  $${overall.avgMonthlyExpenses.toFixed(2)}/mo`);
  console.log(`  Savings rate: ${savingsRateLine}`);
  console.log(`  Categories:   ${categoryStats.length}`);
  console.log(`  Transactions: ${txInWindow} total (in window)`);
  console.log('============================================');

  if (seasonalReady) {
    const runwayDisplay = Number.isFinite(runwayAgainstBurn)
      ? runwayAgainstBurn.toFixed(1)
      : '∞';
    const incomePct =
      offSeasonMonthlyBurn > 0.005
        ? Math.min(100, (offMonthlyIncome / offSeasonMonthlyBurn) * 100)
        : 100;

    console.log('');
    console.log('=== SEASONAL RUNWAY ANALYSIS ===');
    console.log(
      ` Savings banked:           $${totalSavings.toFixed(2)} (${balanceSnapshot.savingsBalanceSource})`,
    );
    console.log(
      offIncomeLabel
        ? ` Monthly off-season income: $${offMonthlyIncome.toFixed(2)} ${offIncomeLabel}`
        : ` Monthly off-season income: $${offMonthlyIncome.toFixed(2)}`,
    );
    console.log(
      ` Monthly off-season burn:   $${offSeasonMonthlyBurn.toFixed(2)} (suggested budget)`,
    );
    console.log(` Monthly net shortfall:     $${monthlyNetBurn.toFixed(2)}`);
    if (monthlyNetBurn > 0.005) {
      console.log(
        ` Savings runway:            ${runwayDisplay} months (savings covers shortfall)`,
      );
    } else {
      console.log(` Savings runway:            ${runwayDisplay} months (no shortfall)`);
    }
    console.log(` Off season length:         ${seasonalEnv.offSeasonMonths} months`);

    if (monthlyNetBurn <= 0.005) {
      console.log(' Status: ON TRACK — income covers expenses');
    } else {
      const runwayOk = runwayAgainstBurn >= seasonalEnv.offSeasonMonths;
      console.log(
        ` Status: ${runwayOk ? 'ON TRACK' : `SHORTFALL — $${monthlyNetBurn.toFixed(2)}/month gap`}`,
      );
      console.log(
        ` To reach ON TRACK: reduce monthly expenses by $${monthlyNetBurn.toFixed(2)}`,
      );
      const diningRow = offBudgetRows?.find(
        (r) => r.stat && /dining/i.test(String(r.stat.name)),
      );
      if (diningRow && diningRow.suggested > 0) {
        const targetD = Math.round(Math.max(200, diningRow.suggested * 0.63) / 5) * 5;
        const closed = Math.min(
          monthlyNetBurn,
          Math.max(0, diningRow.suggested - targetD),
        );
        console.log(
          ` Biggest lever: ${diningRow.stat.name} currently $${diningRow.stat.monthlyAvg.toFixed(0)}/mo → target $${targetD}/mo`,
        );
        console.log(` That alone closes $${closed.toFixed(0)} of the gap.`);
      }
    }

    console.log('');
    console.log(' Income vs expenses:');
    console.log(` Est. monthly income:    $${offMonthlyIncome.toFixed(2)}`);
    console.log(` Suggested budget total: $${offSeasonMonthlyBurn.toFixed(2)}`);
    console.log(` Income covers:          ${incomePct.toFixed(0)}% of expenses`);
    if (monthlyNetBurn > 0.005) {
      console.log(
        ` Savings covers gap:     $${monthlyNetBurn.toFixed(2)}/mo → ${runwayDisplay} months runway`,
      );
    } else {
      console.log(' Savings covers gap:     $0/mo — income covers the budget');
    }
    console.log('============================================');
  } else if (showSimplifiedRunway) {
    const estExp = overall.avgMonthlyExpenses;
    const consRunway = estExp > 0.005 ? totalSavings / estExp : 0;
    console.log('');
    console.log('=== SEASONAL RUNWAY ANALYSIS ===');
    console.log(
      ` Savings banked:        $${totalSavings.toFixed(2)} (${balanceSnapshot.savingsBalanceSource})`,
    );
    console.log(
      ` Est. monthly expenses: $${estExp.toFixed(2)} (based on peak season avg — may be lower off season)`,
    );
    console.log(` Conservative runway:   ${consRunway.toFixed(1)} months`);
    console.log(` Off season length:     ${seasonalEnv.offSeasonMonths} months`);
    console.log(' STATUS: CRITICAL — bank more during next tax season');
    console.log('');
    console.log(' Note: Runway will become more accurate as off-season');
    console.log(' transaction data accumulates (May onwards).');
    console.log('============================================');
  }

  console.log('');
  console.log('--- Category statistics ---');
  console.log(
    padCol('Category', 24) +
      padCol('Avg', 9) +
      padCol('Min', 9) +
      padCol('Max', 9) +
      padCol('Pattern', 10) +
      padCol('Trend', 10) +
      'Vol.',
  );
  for (const c of categoryStats) {
    console.log(
      padCol(c.name, 24) +
        padCol('$' + c.monthlyAvg.toFixed(0), 9) +
        padCol('$' + c.monthlyMin.toFixed(0), 9) +
        padCol('$' + c.monthlyMax.toFixed(0), 9) +
        padCol(c.pattern, 10) +
        padCol(c.trend, 10) +
        c.volatility,
    );
  }

  console.log('');
  console.log('--- Per-month totals ---');
  console.log(
    padCol('Month', 42) +
      padCol('Income*', 12) +
      padCol('Expenses', 12) +
      padCol('Savings**', 12),
  );
  for (const ym of monthKeys) {
    const r = byMonth.get(ym);
    if (!r) continue;
    const inc = monthlyIncomeFromTxs(allTxs, ym);
    const savAbs = Math.abs(r.savingsRaw);
    const tag =
      excludedPartialYm === ym ? ' (partial — excl. avg)' : '';
    console.log(
      padCol(ym + tag, 42) +
        padCol('$' + inc.toFixed(0), 12) +
        padCol('$' + r.expenses.toFixed(0), 12) +
        padCol('$' + savAbs.toFixed(0), 12),
    );
  }
  console.log('* Income = sum of positive transaction amounts for the month');
  console.log(
    '** Savings = absolute net transfer into Savings-named categories (outflows from checking shown as positive here)',
  );
  console.log('');

  const balanceTitle = balanceSnapshot.useEnv
    ? `--- Account Balances (as of ${balanceSnapshot.asOfDate} — update monthly) ---`
    : '--- Account Balances (computed from transactions — may differ from bank) ---';
  console.log(balanceTitle);
  for (const r of balanceSnapshot.rows) {
    console.log(
      `  ${padCol(`${r.label} (${r.suffix}):`, 38)}  ${padCol(formatUsdAmount(r.balance), 14)}  ${r.annotation}`,
    );
  }
  console.log('');
  console.log(
    `  ${padCol('Net worth (excl. liabilities):', 38)}  ${formatUsdAmount(balanceSnapshot.netWorthExclLiabilities)}`,
  );
  console.log(
    `  ${padCol('Net worth (incl. liabilities):', 38)}  ${formatUsdAmount(balanceSnapshot.netWorthInclLiabilities)}`,
  );
  console.log('');
  if (balanceSnapshot.useEnv && balanceSnapshot.asOfDate) {
    console.log(
      `  As of: ${balanceSnapshot.asOfDate} — update ACCOUNT_BALANCE_* in .env monthly`,
    );
  } else {
    console.log(
      '  Set ACCOUNT_BALANCE_CHASE_COLLEGE, ACCOUNT_BALANCE_CHASE_SAVINGS, ACCOUNT_BALANCE_CHASE_FREEDOM, and BALANCE_AS_OF_DATE for bank-accurate balances.',
    );
  }
  console.log('');

  for (const line of formatScheduledTransactionsConsole(scheduleContext)) {
    console.log(line);
  }

  if (exportFlag) {
    const today = new Date();
    const y = today.getFullYear();
    const mo = String(today.getMonth() + 1).padStart(2, '0');
    const da = String(today.getDate()).padStart(2, '0');
    const dateStamp = `${y}-${mo}-${da}`;
    const dir = join(projectRoot, 'summaries');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `budget-plan-${dateStamp}.md`);

    const oneTimeRows = categoryStats.filter((c) => c.pattern === 'one-time');

    let md = `# Budget ideation — ${dateStamp}\n\n`;
    md += `Based on **${overall.monthsAnalyzed}** month(s) used for averages.\n`;
    if (partialNote) md += `\n_${partialNote}_\n`;
    md += `\n## AI narrative\n\n`;
    md += narrative ? narrative : '_Ollama was unavailable; narrative omitted._\n';
    const sinkMd = buildCarInsuranceSinkingFundMd(schedules, payees, nowDate);
    if (sinkMd) {
      md += `\n## Sinking fund targets\n\n${sinkMd}\n`;
    }
    if (billsInvestigationMd) {
      md += `\n${billsInvestigationMd}\n`;
    }
    if (seasonalReady && peakBudgetRows && offBudgetRows) {
      md += `\n### Peak Season Budget (Jan – Apr 15)\n\n`;
      md += `**Peak Season Budget — based on $${peakMonthlyIncome.toFixed(2)}/month income**\n\n`;
      md += `_More aggressive savings targets; discretionary categories may be higher than off-season._\n\n`;
      md += markdownSuggestedBudgetTable(peakBudgetRows);
      md += `\n### Off Season Budget (Apr 16 – Dec)\n\n`;
      md += `**Off Season Budget — based on $${offMonthlyIncome.toFixed(2)}/month income**\n\n`;
      md += `_Conservative spending targets; Savings rows treat reductions as draw-down, not new contributions._\n\n`;
      md += markdownSuggestedBudgetTable(offBudgetRows, {
        mode: 'off',
        offMonthlyIncome,
      });
    } else {
      md += `\n## Suggested budget table\n\n`;
      md += markdownSuggestedBudgetTable(suggestedPlan.rows);
    }

    if (oneTimeRows.length) {
      md += `\n## Irregular one-time expenses (do not budget as monthly)\n\n`;
      md += '| Category | Amount (single month) | Month |\n|----------|----------------------|-------|\n';
      for (const c of oneTimeRows) {
        const hit = c.months.find((m) => m.total > 0.005);
        md += `| ${c.name} | $${hit?.total.toFixed(2) ?? '0.00'} | ${hit?.month ?? '—'} |\n`;
      }
    }

    md += `\n## Raw monthly totals\n\n`;
    md += '| Month | Income* | Expenses | Savings** |\n|-------|---------|----------|----------|\n';
    for (const ym of monthKeys) {
      const r = byMonth.get(ym);
      if (!r) continue;
      const inc = monthlyIncomeFromTxs(allTxs, ym);
      const savAbs = Math.abs(r.savingsRaw);
      const note = excludedPartialYm === ym ? ' *(partial)*' : '';
      md += `| ${ym}${note} | $${inc.toFixed(2)} | $${r.expenses.toFixed(2)} | $${savAbs.toFixed(2)} |\n`;
    }
    md += `\n* Income = sum of positive amounts. ** Savings = absolute transfers into Savings-named categories.\n\n`;
    md += `## Per-category monthly detail\n\n`;
    for (const c of categoryStats) {
      md += `### ${c.name} (${c.pattern})\n\n`;
      md += '| Month | Total | Count |\n|-------|-------|-------|\n';
      for (const row of c.months) {
        md += `| ${row.month} | $${row.total.toFixed(2)} | ${row.count} |\n`;
      }
      md += '\n';
    }

    writeFileSync(path, md, 'utf8');
    console.log(`Wrote ${path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
