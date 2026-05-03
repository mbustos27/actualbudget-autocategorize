import * as api from '@actual-app/api';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import { connect, disconnect, getCategories } from '../src/actual.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/** Categories that should NEVER be set as budget lines (case-insensitive match). */
const ALWAYS_EXCLUDE = [
  'Savings',
  'Starting Balances',
  'Income',
  'Transfer',
  'Transfers',
  'Reimbursements',
  'Reversal',
  'Disputes',
  'Cash',
];

/**
 * @param {string} skipCommaSeparated
 */
function buildExcludedNameSet(skipCommaSeparated = '') {
  const set = new Set(ALWAYS_EXCLUDE.map((n) => n.trim().toLowerCase()));
  for (const part of skipCommaSeparated.split(',')) {
    const s = part.trim().toLowerCase();
    if (s) set.add(s);
  }
  return set;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let fileHint = '';
  let monthOverride = '';
  let skipRaw = '';
  let dryRun = false;
  let overwrite = false;
  let yes = false;
  let currentMonth = false;
  let amountsRaw = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) fileHint = argv[++i];
    else if (a === '--month' && argv[i + 1]) monthOverride = argv[++i];
    else if (a === '--skip' && argv[i + 1]) skipRaw = argv[++i];
    else if (a === '--amounts' && argv[i + 1]) amountsRaw = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--yes') yes = true;
    else if (a === '--current-month') currentMonth = true;
  }

  const envDry =
    process.env.DRY_RUN === 'true' ||
    process.env.DRY_RUN === '1' ||
    String(process.env.DRY_RUN).toLowerCase() === 'yes';
  dryRun = dryRun || envDry || !!config.DRY_RUN;

  return { fileHint, monthOverride, skipRaw, dryRun, overwrite, yes, currentMonth, amountsRaw };
}

function currentMonthYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonthYm() {
  const d = new Date();
  const nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {{ monthOverride: string, currentMonth: boolean }} opts
 */
function resolveTargetYm(opts) {
  if (opts.monthOverride && /^\d{4}-\d{2}$/.test(opts.monthOverride)) {
    return { ym: opts.monthOverride, source: '--month' };
  }
  if (opts.currentMonth) {
    return { ym: currentMonthYm(), source: '--current-month' };
  }
  const env = process.env.BUDGET_TARGET_MONTH?.trim();
  if (env && /^\d{4}-\d{2}$/.test(env)) {
    return { ym: env, source: 'BUDGET_TARGET_MONTH' };
  }
  return { ym: nextMonthYm(), source: 'default (next month)' };
}

/**
 * @param {string} hintPath
 */
function resolvePlanFile(hintPath) {
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
    throw new Error(`Budget plan file not found: ${hintPath}`);
  }

  if (!existsSync(summariesDir)) {
    throw new Error(
      'No summaries/ folder. Run: npm run ideate:export\n',
    );
  }

  const canonicalPlan = join(summariesDir, 'budget-plan-CURRENT.md');
  if (existsSync(canonicalPlan)) {
    return canonicalPlan;
  }

  const names = readdirSync(summariesDir).filter((n) => /^budget-plan-.*\.md$/i.test(n));
  if (!names.length) {
    throw new Error(
      'No budget-plan-*.md in summaries/. Run: npm run ideate:export\n',
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

function displayRelPath(absPath) {
  const fromCwd = relative(process.cwd(), absPath);
  if (fromCwd && !fromCwd.startsWith('..')) return fromCwd.replace(/\\/g, '/');
  return relative(projectRoot, absPath).replace(/\\/g, '/');
}

/**
 * @param {string} raw
 */
function parseSuggestedDollars(raw) {
  const s = String(raw).trim();
  if (!s || /keep\s+as\s+is/i.test(s)) return null;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @returns {boolean}
 */
function detectInPeakSeason() {
  const peakEnd = process.env.PEAK_SEASON_END;
  if (peakEnd == null || String(peakEnd).trim() === '') return false;
  const today = new Date();
  const [em, ed] = String(peakEnd).trim().split('-').map(Number);
  const peakEndDate = new Date(today.getFullYear(), em - 1, ed);
  return today <= peakEndDate;
}

/**
 * @param {string[]} lines
 * @param {number} startIdx
 */
function findNextH2(lines, startIdx) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) return i;
  }
  return lines.length;
}

/**
 * Use content after the **last** literal "Off Season" substring so stacked Ollama tables resolve to the latest.
 * @param {string} text
 * @returns {string | null}
 */
function sliceFromLastOffSeasonContent(text) {
  const needle = 'Off Season';
  const positions = [];
  let pos = text.indexOf(needle);
  while (pos !== -1) {
    positions.push(pos);
    pos = text.indexOf(needle, pos + needle.length);
  }
  if (positions.length === 0) return null;
  const lastOffSeasonPos = positions[positions.length - 1];
  return text.slice(lastOffSeasonPos);
}

/**
 * Split markdown into Peak vs Off sections; pick slice by season or legacy single-table rules.
 * Off season: prefer parsing from {@link sliceFromLastOffSeasonContent} when not in peak season.
 * @param {string} md
 * @returns {{ slice: string, tableLabel: string }}
 */
function extractBudgetTableSlice(md) {
  const lines = md.split(/\r?\n/);
  /** @type {number[]} */
  const peakIndices = [];
  /** @type {number[]} */
  const offSeasonSections = [];
  const peakRe = /^#{1,6}\s+[^\n]*peak\s*season/i;
  const offRe = /^#{1,6}\s+[^\n]*off\s*season/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (peakRe.test(line)) peakIndices.push(i);
    if (offRe.test(line)) offSeasonSections.push(i);
  }

  const hasPeak = peakIndices.length > 0;
  const hasOff = offSeasonSections.length > 0;
  const firstPeak = hasPeak ? peakIndices[0] : -1;
  const firstOff = hasOff ? offSeasonSections[0] : -1;
  const offSeasonTable =
    hasOff ? offSeasonSections[offSeasonSections.length - 1] : -1;

  const inPeakSeason = detectInPeakSeason();

  if (inPeakSeason) {
    if (hasPeak && hasOff && firstPeak < firstOff) {
      return {
        slice: lines.slice(firstPeak, firstOff).join('\n'),
        tableLabel: 'Peak Season',
      };
    }
    if (hasPeak && hasOff && firstPeak >= firstOff) {
      return {
        slice: lines.slice(firstPeak, findNextH2(lines, firstPeak)).join('\n'),
        tableLabel: 'Peak Season',
      };
    }
    if (hasPeak && !hasOff) {
      return {
        slice: lines.slice(firstPeak, findNextH2(lines, firstPeak)).join('\n'),
        tableLabel: 'Peak Season',
      };
    }
  } else {
    const offSeasonContent = sliceFromLastOffSeasonContent(md);
    if (offSeasonContent !== null) {
      return { slice: offSeasonContent, tableLabel: 'Off Season' };
    }

    if (hasPeak && hasOff) {
      if (firstPeak < firstOff) {
        return {
          slice: lines.slice(offSeasonTable, findNextH2(lines, offSeasonTable)).join('\n'),
          tableLabel: 'Off Season',
        };
      }
      if (offSeasonTable > firstPeak) {
        return {
          slice: lines.slice(offSeasonTable, findNextH2(lines, offSeasonTable)).join('\n'),
          tableLabel: 'Off Season',
        };
      }
      return {
        slice: lines.slice(offSeasonTable, firstPeak).join('\n'),
        tableLabel: 'Off Season',
      };
    }

    if (!hasPeak && hasOff) {
      return {
        slice: lines.slice(offSeasonTable, findNextH2(lines, offSeasonTable)).join('\n'),
        tableLabel: 'Off Season',
      };
    }
  }

  if (hasPeak && !hasOff) {
    return {
      slice: lines.slice(firstPeak, findNextH2(lines, firstPeak)).join('\n'),
      tableLabel: 'Peak Season',
    };
  }

  return { slice: md, tableLabel: 'legacy' };
}

/**
 * @param {string} markdownText
 * @param {Set<string>} excludedNames
 * @returns {{ entries: { name: string, cents: number }[], excludedCount: number }}
 */
function parseBudgetPlan(markdownText, excludedNames) {
  const { slice, tableLabel } = extractBudgetTableSlice(markdownText);
  if (tableLabel === 'legacy') {
    console.log('Reading: budget table (current period — legacy export)');
  } else {
    console.log(`Reading: ${tableLabel} budget table (current period)`);
  }
  return parseSuggestedBudgetTable(slice, excludedNames);
}

/**
 * @param {string} md
 * @param {Set<string>} excludedNames
 * @returns {{ entries: { name: string, cents: number }[], excludedCount: number }}
 */
function parseSuggestedBudgetTable(md, excludedNames) {
  const lower = md.toLowerCase();
  const idx = lower.indexOf('## suggested budget table');
  const slice = idx >= 0 ? md.slice(idx) : md;

  const lines = slice.split(/\r?\n/);
  /** @type {{ name: string, cents: number }[]} */
  const out = [];
  let excludedCount = 0;

  let started = false;
  for (const line of lines) {
    if (!started && line.includes('|') && /category/i.test(line) && /suggested\s+budget/i.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (!line.trim().startsWith('|')) break;
    const sep = /^\|[\s\-:|]+\|\s*$/.test(line.replace(/\s/g, ''));
    if (sep) continue;

    const parts = line.split('|').map((c) => c.trim());
    if (parts.length < 5) continue;

    const name = parts[1];
    const suggestedRaw = parts[3];
    if (!name || /^category$/i.test(name)) continue;

    const key = name.trim().toLowerCase();
    if (excludedNames.has(key)) {
      excludedCount++;
      continue;
    }

    const dollars = parseSuggestedDollars(suggestedRaw);
    if (dollars == null) continue;

    const cents = Math.round(dollars * 100);
    if (cents <= 0) continue;

    out.push({ name: name.trim(), cents });
  }

  return { entries: out, excludedCount };
}

const MINIMUM_AMOUNTS = {
  Bills: 300,
  'Auto & Gas': 200,
  Utilities: 50,
  Software: 40,
  Groceries: 100,
  'Dining Out': 200,
  Shopping: 200,
};

/**
 * @param {string} name
 */
function minimumForCategoryName(name) {
  const n = String(name).trim();
  if (Object.prototype.hasOwnProperty.call(MINIMUM_AMOUNTS, n)) {
    return MINIMUM_AMOUNTS[n];
  }
  const lower = n.toLowerCase();
  for (const [k, v] of Object.entries(MINIMUM_AMOUNTS)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * @param {{ name: string, cents: number }[]} entries
 */
function validateMinimumBudgetAmounts(entries) {
  /** @type {{ name: string, cents: number }[]} */
  const out = [];
  for (const e of entries) {
    const min = minimumForCategoryName(e.name);
    if (min === undefined) {
      out.push(e);
      continue;
    }
    const amount = e.cents / 100;
    if (amount < min) {
      console.warn(
        `Warning: ${e.name} parsed as $${amount.toFixed(2)} which is below minimum $${min} — skipping`,
      );
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * @param {string} raw
 * @returns {Map<string, number>}
 */
function parseAmountOverrides(raw) {
  const map = new Map();
  if (!raw?.trim()) return map;
  for (const segment of raw.split(',')) {
    const seg = segment.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const val = parseFloat(seg.slice(eq + 1).trim());
    if (!name || !Number.isFinite(val)) continue;
    map.set(name, val);
  }
  return map;
}

/**
 * @param {{ name: string, cents: number }[]} entries
 * @param {Map<string, number>} overrideMap
 */
function applyAmountOverrides(entries, overrideMap) {
  if (!overrideMap.size) return entries;
  /** @type {Map<string, { display: string, dollars: number }>} */
  const ovByLower = new Map();
  for (const [k, dollars] of overrideMap) {
    ovByLower.set(k.trim().toLowerCase(), { display: k.trim(), dollars });
  }
  /** @type {{ name: string, cents: number }[]} */
  const out = [];
  const matched = new Set();
  for (const e of entries) {
    const lk = e.name.trim().toLowerCase();
    const ov = ovByLower.get(lk);
    if (ov) {
      out.push({ name: e.name, cents: Math.round(ov.dollars * 100) });
      matched.add(lk);
    } else {
      out.push(e);
    }
  }
  for (const [lk, ov] of ovByLower) {
    if (matched.has(lk)) continue;
    out.push({ name: ov.display, cents: Math.round(ov.dollars * 100) });
  }
  return out;
}

/**
 * @param {object} budgetMonth
 * @returns {Map<string, number>}
 */
function flattenExpenseBudgets(budgetMonth) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const g of budgetMonth.categoryGroups || []) {
    if (g.is_income) continue;
    for (const c of g.categories || []) {
      map.set(c.id, Number(c.budgeted) || 0);
    }
  }
  return map;
}

/**
 * @param {string} ym
 */
function monthTitle(ym) {
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * @param {string} question
 */
async function promptYn(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => {
    rl.question(question, res);
  });
  rl.close();
  const s = String(answer).trim().toLowerCase();
  if (s === 'n' || s === 'no') return false;
  return true;
}

/**
 * @param {string} s
 * @param {number} w
 */
function padEnd(s, w) {
  return String(s).slice(0, w).padEnd(w);
}

/**
 * @param {{ name: string, cents: number }[]} rows
 * @param {string} targetYm
 */
function buildCanonicalBudgetMarkdown(rows, targetYm) {
  const seasonHeading = detectInPeakSeason() ? 'Peak Season' : 'Off Season';
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '# Budget plan (canonical)',
    '',
    `_Generated by apply-budget.mjs (\`--amounts\`, successful apply for ${targetYm})._`,
    '',
    `## ${seasonHeading}`,
    '',
    '| Category | Suggested Budget |',
    '| --- | --- |',
  ];
  for (const r of sorted) {
    lines.push(`| ${r.name} | $${(r.cents / 100).toFixed(2)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  let planPath;
  try {
    planPath = resolvePlanFile(opts.fileHint);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const rel = displayRelPath(planPath);
  console.log(`Using budget plan: ${rel}`);

  const md = readFileSync(planPath, 'utf8');
  const excludedNames = buildExcludedNameSet(opts.skipRaw);
  const amountOverrides = parseAmountOverrides(opts.amountsRaw);
  let { entries: parsed, excludedCount: skippedExcludedParse } = parseBudgetPlan(
    md,
    excludedNames,
  );
  parsed = applyAmountOverrides(parsed, amountOverrides);
  parsed = validateMinimumBudgetAmounts(parsed);
  if (!parsed.length) {
    console.error(
      'No suggested budget rows parsed. Expected a seasonal table (Peak Season / Off Season) or "## Suggested budget table" with pipe rows.',
    );
    process.exit(1);
  }

  const { ym: targetYm, source: targetSource } = resolveTargetYm(opts);
  const curYm = currentMonthYm();

  const monthExplicitlySet =
    Boolean(opts.monthOverride && /^\d{4}-\d{2}$/.test(opts.monthOverride));
  if (!monthExplicitlySet && targetYm === curYm && !opts.currentMonth) {
    console.error(
      `Refusing to apply to the current month (${targetYm}) without --current-month.\n` +
        `Default target is next month — omit --month or use BUDGET_TARGET_MONTH.\n`,
    );
    process.exit(1);
  }

  console.log(`Target month: ${targetYm} (${targetSource})`);

  await connect();

  const categories = await getCategories();
  const nameToCat = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));

  /** @type {{ name: string, cents: number, cat: object }[]} */
  const resolved = [];
  let skippedNoMatch = 0;

  for (const row of parsed) {
    const key = row.name.trim().toLowerCase();
    const cat = nameToCat.get(key);
    if (!cat) {
      console.warn(
        `Warning: category '${row.name}' not found in Actual Budget — skipping`,
      );
      skippedNoMatch++;
      continue;
    }
    resolved.push({ name: row.name, cents: row.cents, cat });
  }

  const budgetMonth = await api.getBudgetMonth(targetYm);
  const existingBudgets = flattenExpenseBudgets(budgetMonth);

  /** @type {{ name: string, cents: number, cat: object, existing: number }[]} */
  const toApply = [];
  let skippedExisting = 0;

  for (const r of resolved) {
    const existing = existingBudgets.get(r.cat.id) ?? 0;
    if (existing !== 0 && Math.round(existing) !== r.cents && !opts.overwrite) {
      const dollars = (existing / 100).toFixed(2);
      console.warn(
        `Skipping ${r.name} — budget already set to $${dollars}. Use --overwrite to replace.`,
      );
      skippedExisting++;
      continue;
    }
    toApply.push({ ...r, existing });
  }

  console.log('');
  console.log('Planned changes:');
  for (const r of toApply) {
    const d = (r.cents / 100).toFixed(2);
    const tag = opts.dryRun ? '[DRY RUN] Would set' : 'Will set';
    console.log(`  ${tag} ${r.name} → $${d} for ${targetYm}`);
  }
  console.log('');

  if (!opts.dryRun && !opts.yes) {
    const ok = await promptYn(
      `Apply this budget to ${monthTitle(targetYm)} (${targetYm})? (Y/n) `,
    );
    if (!ok) {
      console.log('Cancelled.');
      await disconnect();
      process.exit(0);
    }
  }

  let applied = 0;

  if (toApply.length) {
    if (opts.dryRun) {
      for (const r of toApply) {
        console.log(
          `[DRY RUN] Would set ${r.name} → $${(r.cents / 100).toFixed(2)} for ${targetYm}`,
        );
        applied++;
      }
    } else {
      await api.batchBudgetUpdates(async () => {
        for (const r of toApply) {
          await api.setBudgetAmount(targetYm, r.cat.id, r.cents);
          applied++;
        }
      });
    }
  }

  if (!opts.dryRun && opts.amountsRaw?.trim() && applied > 0) {
    const canonicalPath = join(projectRoot, 'summaries', 'budget-plan-CURRENT.md');
    writeFileSync(canonicalPath, buildCanonicalBudgetMarkdown(toApply, targetYm), 'utf8');
    console.log(`Wrote canonical plan: ${displayRelPath(canonicalPath)}`);
  }

  await disconnect();

  console.log('');
  console.log(`Budget Applied: ${monthTitle(targetYm)}`);
  console.log('=========================');
  console.log(`Source: ${rel}`);
  console.log('');
  console.log(padEnd('Category', 18) + padEnd('Suggested', 14) + 'Applied');

  for (const r of toApply) {
    const sug = `$${(r.cents / 100).toFixed(2)}`;
    const line =
      padEnd(r.name, 18) + padEnd(sug, 14) + (opts.dryRun ? '(dry run)' : '✓');
    console.log(line);
  }

  console.log('');
  console.log(
    `${applied} categories ${opts.dryRun ? 'previewed for ' : 'updated for '} ${targetYm}`,
  );
  console.log(
    `Skipped: ${skippedNoMatch} (no match), ${skippedExcludedParse} (excluded), ${skippedExisting} (already set)`,
  );
  console.log('');
  console.log('Open Actual Budget to review. You can adjust any amount manually.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
