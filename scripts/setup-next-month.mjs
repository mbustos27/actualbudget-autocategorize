import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function nextMonthYm() {
  const d = new Date();
  const nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}`;
}

function monthTitle(ym) {
  const [y, mo] = ym.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function findLatestBudgetPlanPath() {
  const summariesDir = join(projectRoot, 'summaries');
  if (!existsSync(summariesDir)) return null;
  const names = readdirSync(summariesDir).filter((n) => /^budget-plan-.*\.md$/i.test(n));
  if (!names.length) return null;
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
  return best || null;
}

/**
 * @param {string} md
 */
function extractSuggestedTable(md) {
  const m = md.match(/## Suggested budget table\s*\r?\n([\s\S]*?)(?=\r?\n## |\s*$)/i);
  return m
    ? m[1].trim()
    : '(Could not find "## Suggested budget table" in export.)';
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

async function main() {
  const argv = process.argv.slice(2);
  const skipPrompt = argv.includes('--yes');

  console.log('Running ideate-budget with export (default window)...\n');
  const ideate = spawnSync(
    process.execPath,
    [join(projectRoot, 'scripts/ideate-budget.mjs'), '--export'],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (ideate.status !== 0) {
    process.exit(ideate.status ?? 1);
  }

  const latestPath = findLatestBudgetPlanPath();
  if (!latestPath) {
    console.error('No budget-plan-*.md found in summaries/ after export.');
    process.exit(1);
  }

  const md = readFileSync(latestPath, 'utf8');
  const tableBlock = extractSuggestedTable(md);

  console.log('\n--- Suggested budget table (review) ---\n');
  console.log(tableBlock);
  console.log('\n--- End table ---\n');

  const nm = nextMonthYm();
  const title = monthTitle(nm);

  if (!skipPrompt) {
    const ok = await promptYn(`Apply this budget to ${title} (${nm})? (Y/n) `);
    if (!ok) {
      console.log('Skipped applying budgets.');
      process.exit(0);
    }
  }

  const apply = spawnSync(
    process.execPath,
    [
      join(projectRoot, 'scripts/apply-budget.mjs'),
      '--yes',
      '--file',
      basename(latestPath),
      '--month',
      nm,
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  process.exit(apply.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
