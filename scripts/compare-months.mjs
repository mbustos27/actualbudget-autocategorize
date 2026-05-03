import * as api from '@actual-app/api';
import { config } from '../src/config.js';
import { connect, getAccounts, getCategories, disconnect } from '../src/actual.js';

const monthA = process.argv[2];
const monthB = process.argv[3];

if (!monthA || !monthB || !/^\d{4}-\d{2}$/.test(monthA) || !/^\d{4}-\d{2}$/.test(monthB)) {
  console.log('Usage: node scripts/compare-months.mjs <YYYY-MM> <YYYY-MM>');
  console.log('Example: node scripts/compare-months.mjs 2026-03 2026-04');
  process.exit(1);
}

/**
 * @param {string} ym
 */
function monthShortLabel(ym) {
  const [y, mo] = ym.split('-').map(Number);
  const d = new Date(y, mo - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * @param {string} ym
 */
function monthAbbrev(ym) {
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

/**
 * @param {object[]} txs
 * @param {string} ym
 * @param {Map<string, string>} catIdToName
 * @returns {Map<string, number>}
 */
function expenseTotalsByCategory(txs, ym) {
  const map = new Map();
  for (const t of txs) {
    if (!t.date || !String(t.date).startsWith(ym) || Number(t.amount) === 0) continue;
    if (Number(t.amount) >= 0) continue;
    const cid = t.category;
    if (cid == null || cid === '') continue;
    const key = cid;
    const add = -Number(t.amount) / 100;
    map.set(key, (map.get(key) || 0) + add);
  }
  return map;
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
  await connect();

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

  const totalsA = expenseTotalsByCategory(allTxs, monthA);
  const totalsB = expenseTotalsByCategory(allTxs, monthB);

  const catIds = new Set([...totalsA.keys(), ...totalsB.keys()]);
  /** @type { { name: string, a: number, b: number, diff: number, pct: number, arrow: string, tag: string }[]} */
  const rows = [];

  for (const cid of catIds) {
    const a = totalsA.get(cid) || 0;
    const b = totalsB.get(cid) || 0;
    if (a === 0 && b === 0) continue;
    const name = catIdToName.get(cid) ?? cid;
    const diff = b - a;
    let pct = 0;
    if (a !== 0) {
      pct = (diff / a) * 100;
    } else if (b !== 0) {
      pct = 100;
    }

    let arrow = '→';
    let tag = '';
    if (diff > 0.005) {
      arrow = '↑';
      if (Math.abs(pct) >= 25) tag = ' WATCH';
    } else if (diff < -0.005) {
      arrow = '↓';
      tag = ' IMPROVED';
    }

    rows.push({ name, a, b, diff, pct, arrow, tag });
  }

  rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  const labelA = monthShortLabel(monthA);
  const labelB = monthShortLabel(monthB);
  const colA = monthAbbrev(monthA);
  const colB = monthAbbrev(monthB);

  console.log('');
  console.log(`Month Comparison: ${labelA} vs ${labelB}`);
  console.log('=======================================');

  const wName = 18;
  const fmtAmt = (n) => `$${n.toFixed(0)}`.padStart(7);

  console.log(
    `${'Category'.padEnd(wName)} ${colA.padStart(6)} ${colB.padStart(6)}    Change`,
  );

  const linesForOllama = [];

  for (const r of rows) {
    const changeStr =
      r.diff >= 0
        ? `+$${r.diff.toFixed(0)}  (+${r.pct.toFixed(0)}%)`
        : `-$${Math.abs(r.diff).toFixed(0)}  (${r.pct.toFixed(0)}%)`;
    console.log(
      `${r.name.slice(0, wName).padEnd(wName)} ${fmtAmt(r.a)} ${fmtAmt(r.b)}    ${changeStr} ${r.arrow}${r.tag}`,
    );
    linesForOllama.push(
      `${r.name}: ${labelA} $${r.a.toFixed(2)} → ${labelB} $${r.b.toFixed(2)} (${r.diff >= 0 ? '+' : ''}$${r.diff.toFixed(2)}, ${r.pct.toFixed(0)}%)`,
    );
  }

  console.log('');

  const prompt = `
Compare these two months of household expense totals by category (amounts are spending only — negative transactions summed as positive dollars).

Month A: ${monthA} (${labelA})
Month B: ${monthB} (${labelB})

${linesForOllama.join('\n')}

Write a brief narrative (about 150 words) on what changed month to month and why it might matter for budgeting. Be specific with categories and amounts. No bullet list — short paragraphs.
`.trim();

  try {
    const narrative = await ollamaGenerate(prompt);
    console.log(narrative.trim());
    console.log('');
  } catch (e) {
    console.error('✗ Could not reach Ollama:', e.message);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
