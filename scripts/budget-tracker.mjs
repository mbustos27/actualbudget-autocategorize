import * as api from '@actual-app/api';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
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
  let budgetPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--budget' && argv[i + 1]) {
      budgetPath = argv[++i];
    }
  }
  return { budgetPath };
}

/**
 * @param {string} s
 */
function parseMoney(s) {
  const n = Number(String(s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {string} md
 * @returns {{ name: string, budgeted: number }[]}
 */
function parseBudgetTable(md) {
  const lines = md.split(/\r?\n/);
  /** @type {{ name: string, budgeted: number }[]} */
  const rows = [];
  let catIdx = -1;
  let suggestedIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;

    const headerHit =
      cells.some((c) => /^category$/i.test(c)) &&
      cells.some((c) => /suggested/i.test(c) && /budget/i.test(c));

    if (headerHit) {
      for (let j = 0; j < cells.length; j++) {
        if (/^category$/i.test(cells[j])) catIdx = j;
        if (/suggested/i.test(cells[j]) && /budget/i.test(cells[j])) suggestedIdx = j;
      }
      if (catIdx === -1 || suggestedIdx === -1) continue;

      for (let k = i + 1; k < lines.length; k++) {
        const rowLine = lines[k];
        if (!rowLine.trim().startsWith('|')) break;

        const parts = rowLine.split('|').map((c) => c.trim());
        const inner = parts.slice(1, -1);
        if (inner.length && inner.every((p) => !p || /^[-:]+$/.test(p))) continue;

        const name = parts[catIdx];
        const suggestedRaw = parts[suggestedIdx];
        if (!name || /^category$/i.test(name)) continue;
        const budgeted = parseMoney(suggestedRaw);
        rows.push({ name, budgeted });
      }
      break;
    }
  }

  return rows;
}

/**
 * @param {string} hintPath
 */
function resolveBudgetFile(hintPath) {
  const summariesDir = join(projectRoot, 'summaries');

  if (hintPath) {
    const candidates = [
      resolve(hintPath),
      join(process.cwd(), hintPath),
      join(summariesDir, basename(hintPath)),
      join(projectRoot, hintPath),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new Error(`Budget file not found: ${hintPath}`);
  }

  if (!existsSync(summariesDir)) {
    throw new Error(
      `No summaries/ folder and no --budget path. Export a plan first (npm run ideate:export) or pass --budget.`,
    );
  }

  const names = readdirSync(summariesDir).filter((n) => /^budget-plan-.*\.md$/i.test(n));
  if (!names.length) {
    throw new Error(
      `No budget-plan-*.md in summaries/. Run ideate with --export or pass --budget path.`,
    );
  }

  let best = '';
  let bestTime = 0;
  for (const n of names) {
    const p = join(summariesDir, n);
    try {
      const t = statSync(p).mtimeMs;
      if (t >= bestTime) {
        bestTime = t;
        best = p;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

/**
 * @param {string} absPath
 */
function displayBudgetRelPath(absPath) {
  const fromCwd = relative(process.cwd(), absPath);
  if (fromCwd && !fromCwd.startsWith('..')) {
    return fromCwd.replace(/\\/g, '/');
  }
  return relative(projectRoot, absPath).replace(/\\/g, '/');
}

/**
 * @param {string} ym
 */
function daysInMonthYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * @param {string} ym
 */
function monthTitle(ym) {
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * @param {string} name
 */
function shouldExcludeBudgetCategoryName(name) {
  const n = String(name || '').trim();
  return n === 'Starting Balances' || n === 'Income';
}

/**
 * @param {object[]} txs
 * @param {string} ym
 * @param {Map<string, string>} catIdToName
 * @returns {Map<string, number>}
 */
function expenseByCategoryName(txs, ym, catIdToName) {
  const map = new Map();
  for (const t of txs) {
    if (!t.date || !String(t.date).startsWith(ym) || Number(t.amount) === 0) continue;
    if (Number(t.amount) >= 0) continue;
    const cid = t.category;
    const catName =
      cid != null && cid !== ''
        ? catIdToName.get(cid) ?? '(uncategorized)'
        : '(uncategorized)';
    if (shouldExcludeBudgetCategoryName(catName)) continue;
    const add = -Number(t.amount) / 100;
    const key = catName;
    map.set(key, (map.get(key) || 0) + add);
  }
  return map;
}

/**
 * @param {string} a
 * @param {string} b
 */
function namesMatch(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
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
 * @param {string} s
 * @param {number} w
 */
function pad(s, w) {
  return String(s).slice(0, w).padEnd(w);
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

function normalizeFrequency(rule) {
  const f = String(rule.frequency ?? '').toLowerCase();
  if (f === 'weekly') return 'weekly';
  if (f === 'monthly') return 'monthly';
  if (f === 'yearly' || f === 'annually') return 'yearly';
  return f;
}

/**
 * @param {object} schedule
 * @param {Map<string, string>} payeeById
 */
function schedulePayeeLabel(schedule, payeeById) {
  const id = schedule.payee;
  if (id != null && payeeById.has(String(id))) return payeeById.get(String(id));
  return String(schedule.name || '').trim() || 'Scheduled';
}

function lumpScheduleAmount(schedule) {
  return Math.abs(Number(schedule.amount)) / 100;
}

/**
 * @param {object[]} schedules
 * @param {Map<string, string>} payeeById
 */
function formatUpcomingScheduledPayments(schedules, payeeById) {
  /** @type {{ t: number, text: string }[]} */
  const rows = [];
  for (const s of schedules) {
    if (s.completed) continue;
    const next = String(s.next_date || '').slice(0, 10);
    if (!next) continue;
    const nd = new Date(`${next}T12:00:00`);
    if (Number.isNaN(nd.getTime())) continue;
    const label = schedulePayeeLabel(s, payeeById);
    const dollars = lumpScheduleAmount(s);
    const amtSigned = Number(s.amount);
    const signChar = amtSigned >= 0 ? '+' : '−';
    const rule = parseScheduleDateRule(s);
    let tail = '';
    if (normalizeFrequency(rule) === 'monthly' && Number(rule.interval ?? 1) === 6) {
      tail = `  (set aside $${(dollars / 6).toFixed(0)}/mo)`;
    }
    const dayStr = nd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    rows.push({
      t: nd.getTime(),
      text: `  ${dayStr}:  ${pad(label, 18)} ${signChar}$${dollars.toFixed(2)}${tail}`,
    });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.map((r) => r.text);
}

async function main() {
  const argv = process.argv.slice(2);
  const { budgetPath: hint } = parseArgs(argv);

  const budgetFile = resolveBudgetFile(hint);
  console.log(`Using budget plan: ${displayBudgetRelPath(budgetFile)}`);
  const md = readFileSync(budgetFile, 'utf8');
  const budgetRows = parseBudgetTable(md);

  if (!budgetRows.length) {
    console.error(
      `Could not parse a budget table from ${budgetFile}. Expected columns "Category" and "Suggested Budget".`,
    );
    process.exit(1);
  }

  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dim = daysInMonthYm(ym);
  const dayToday = now.getDate();
  const daysIntoMonth = Math.min(dayToday, dim);

  await connect();

  const categories = await getCategories();
  const catIdToName = new Map(categories.map((c) => [c.id, c.name]));

  const payees = await getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));

  /** @type {object[]} */
  let schedules = [];
  try {
    schedules = await getSchedules();
  } catch {
    schedules = [];
  }

  const accounts = await getAccounts();
  /** @type {object[]} */
  const allTxs = [];
  for (const acc of accounts) {
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    allTxs.push(...txs);
  }

  await disconnect();

  const spentMap = expenseByCategoryName(allTxs, ym, catIdToName);

  /** @type {{ category: string, budgeted: number, spent: number, remaining: number, percentUsed: number, daysIntoMonth: number, projectedTotal: number, status: string, note: string }[]} */
  const rows = [];

  let sumBudget = 0;
  let sumSpent = 0;

  for (const br of budgetRows) {
    let spent = 0;
    for (const [name, val] of spentMap) {
      if (namesMatch(name, br.name)) {
        spent = val;
        break;
      }
    }

    const budgeted = br.budgeted;
    const remaining = budgeted - spent;
    const percentUsed = budgeted > 0 ? Math.round((spent / budgeted) * 100) : spent > 0 ? 100 : 0;

    const projectedTotal =
      daysIntoMonth > 0 ? (spent / daysIntoMonth) * dim : spent;

    let status = 'ON TRACK';
    let note = '';

    if (spent > budgeted + 0.01) {
      status = 'OVER BUDGET';
      note = `($${(spent - budgeted).toFixed(0)} over)`;
    } else if (projectedTotal > budgeted + 0.01) {
      status = 'WARNING';
      const overBy = projectedTotal - budgeted;
      note = `(proj over by $${overBy.toFixed(0)})`;
    }

    rows.push({
      category: br.name,
      budgeted,
      spent,
      remaining,
      percentUsed,
      daysIntoMonth,
      projectedTotal,
      status,
      note,
    });

    sumBudget += budgeted;
    sumSpent += spent;
  }

  const sumRemaining = sumBudget - sumSpent;
  const sumProj =
    daysIntoMonth > 0 ? (sumSpent / daysIntoMonth) * dim : sumSpent;

  const title = monthTitle(ym);

  console.log('');
  console.log(`Budget Tracker — ${title} (day ${daysIntoMonth} of ${dim})`);
  console.log('==========================================');
  console.log(
    pad('Category', 16) +
      pad('Budget', 10) +
      pad('Spent', 10) +
      pad('Left', 10) +
      pad('Proj', 10) +
      'Status',
  );

  for (const r of rows) {
    const line =
      pad(r.category, 16) +
      pad('$' + r.budgeted.toFixed(0), 10) +
      pad('$' + r.spent.toFixed(0), 10) +
      pad('$' + r.remaining.toFixed(0), 10) +
      pad('$' + r.projectedTotal.toFixed(0), 10) +
      `${r.status} ${r.note}`.trim();
    console.log(line);
  }

  console.log('==========================================');
  console.log(
    pad('Total', 16) +
      pad('$' + sumBudget.toFixed(0), 10) +
      pad('$' + sumSpent.toFixed(0), 10) +
      pad('$' + sumRemaining.toFixed(0), 10) +
      pad('$' + sumProj.toFixed(0), 10),
  );
  console.log('');

  const upcoming = formatUpcomingScheduledPayments(schedules, payeeById);
  if (upcoming.length) {
    console.log('--- Upcoming Scheduled Payments ---');
    for (const ln of upcoming) {
      console.log(ln);
    }
    console.log('');
  }

  const trackerBlob = rows
    .map(
      (r) =>
        `- ${r.category}: budget $${r.budgeted}, spent $${r.spent}, projected month-end ~$${r.projectedTotal.toFixed(0)} — ${r.status}`,
    )
    .join('\n');

  const checkInPrompt = `
You are giving a brief mid-month budget check-in (about 100 words).
Today we are day ${daysIntoMonth} of ${dim} in ${title}.

Tracker (from Actual Budget vs exported plan ${basename(budgetFile)}):
${trackerBlob}

Totals: budgeted $${sumBudget.toFixed(0)}, spent so far $${sumSpent.toFixed(0)}, projected month-end ~$${sumProj.toFixed(0)}.

Write a supportive, direct mini check-in: what stands out, one priority tweak if needed. No bullet labels required — short paragraphs OK.
`.trim();

  try {
    const text = (await ollamaGenerate(checkInPrompt)).trim();
    console.log(text);
    console.log('');
  } catch (e) {
    console.error('✗ Ollama check-in unavailable:', e.message);
    console.error('  Raw tracker table above is still valid.\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
