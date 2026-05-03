/**
 * Quick financial snapshot: .env balances + scheduled transactions (no Ollama).
 */
import '../src/config.js';
import { connect, disconnect, getAccounts, getPayees, getSchedules } from '../src/actual.js';

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
 * @param {object} account
 */
function accountDisplaySuffix(account) {
  const id = String(account?.id ?? '');
  return id.length >= 4 ? id.slice(-4) : id || '????';
}

/**
 * @param {object[]} accounts
 */
function resolveBalanceSnapshot(accounts) {
  const asOfDate = process.env.BALANCE_AS_OF_DATE?.trim() || null;
  const bCollege = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_COLLEGE');
  const bSavings = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_SAVINGS');
  const bFreedom = parseEnvAccountBalance('ACCOUNT_BALANCE_CHASE_FREEDOM');

  const useEnv =
    Boolean(asOfDate) && bCollege != null && bSavings != null && bFreedom != null;

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

  /** @type {{ label: string, suffix: string, balance: number, kind: string }[]} */
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
    rows.push({ label, suffix, balance, kind: spec.kind });
  }

  const collegeBal = rows[0]?.balance ?? 0;
  const savingsBal = rows[1]?.balance ?? 0;
  const freedomBal = rows[2]?.balance ?? 0;
  const totalAssets = collegeBal + savingsBal;
  const totalLiabilities = freedomBal < 0 ? freedomBal : 0;
  const netWorth = collegeBal + savingsBal + freedomBal;

  return {
    useEnv,
    asOfDate,
    rows,
    totalAssets,
    totalLiabilities,
    netWorth,
    savingsBalance: useEnv && bSavings != null ? bSavings : savingsBal,
  };
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
 * Sum monthly equivalent of all committed expense schedules (amount < 0).
 * @param {object[]} schedules
 */
function totalMonthlyCommittedExpenses(schedules) {
  let s = 0;
  for (const sch of schedules) {
    if (sch.completed) continue;
    if (Number(sch.amount) >= 0) continue;
    s += getMonthlyScheduleAmount(sch);
  }
  return s;
}

/**
 * @param {object[]} schedules
 * @param {{ id: string, name: string }[]} payees
 */
function schedulesNext30Days(schedules, payees) {
  const today = new Date();
  const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  const upcoming = schedules.filter((s) => {
    if (s.completed) return false;
    if (!s.next_date) return false;
    const nextDate = new Date(s.next_date);
    if (Number.isNaN(nextDate.getTime())) return false;
    return nextDate >= today && nextDate <= in30Days;
  });

  upcoming.sort(
    (a, b) => new Date(a.next_date).getTime() - new Date(b.next_date).getTime(),
  );

  return upcoming.map((sch) => {
    const nextDate = new Date(sch.next_date);
    const rawScheduleName = String(sch.name ?? '').trim();
    const displayName = rawScheduleName || resolvePayeeName(sch, payees);
    const dollars = Number(sch.amount) / 100;
    const absStr = Math.abs(dollars).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const amtStr = `${dollars >= 0 ? '+' : '-'}$${absStr}`;
    const dayMonth = nextDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const name = displayName.padEnd(32).substring(0, 32);
    return `  ${dayMonth}:  ${name} ${amtStr}`;
  });
}

/**
 * @param {string} s
 * @param {number} w
 */
function padEnd(s, w) {
  return String(s).slice(0, w).padEnd(w);
}

/**
 * @param {number} n
 */
function fmtUsd(n) {
  const neg = n < 0;
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `-$${str}` : `$${str}`;
}

/**
 * @param {number} n
 */
function fmtUsdSignedMonthly(n) {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}$${abs}/month`;
}

async function main() {
  await connect();
  try {
    const accounts = await getAccounts();
    const payees = await getPayees();
    const schedules = await getSchedules();

    const snap = resolveBalanceSnapshot(accounts);
    const committed = totalMonthlyCommittedExpenses(schedules);

    const offRaw = process.env.OFF_SEASON_MONTHLY_INCOME?.trim();
    const offIncome =
      offRaw !== undefined && offRaw !== '' ? Number.parseFloat(offRaw) : NaN;
    const offIncomeOk = Number.isFinite(offIncome) && offIncome >= 0;

    const freeCash = offIncomeOk ? offIncome - committed : NaN;

    const savingsBal = snap.savingsBalance;
    const shortfall = offIncomeOk ? Math.max(0, committed - offIncome) : NaN;

    /** @type {string} */
    let runwayDisplay;
    if (!offIncomeOk) {
      runwayDisplay = 'N/A (set OFF_SEASON_MONTHLY_INCOME)';
    } else if (shortfall <= 0.005) {
      runwayDisplay = '∞ months (ON TRACK)';
    } else if (savingsBal > 0) {
      const m = savingsBal / shortfall;
      runwayDisplay = `${m.toFixed(1)} months (SHORTFALL)`;
    } else {
      runwayDisplay = '0 months (SHORTFALL)';
    }

    const today = new Date();
    const headerDate =
      snap.asOfDate ||
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const kindLabel = (k) =>
      k === 'checking' ? 'Checking' : k === 'savings' ? 'Savings' : 'Credit';

    console.log('');
    console.log(`=== Financial Snapshot (${headerDate}) ===`);
    console.log('');
    console.log('Accounts:');
    for (const r of snap.rows) {
      const tag = kindLabel(r.kind);
      const left = `  ${padEnd(tag, 10)} ${r.label} (${r.suffix}):`;
      console.log(`${padEnd(left, 52)}${fmtUsd(r.balance)}`);
    }
    console.log('');
    console.log(`  Total assets:      ${fmtUsd(snap.totalAssets)}`);
    console.log(`  Total liabilities: ${fmtUsd(snap.totalLiabilities)}`);
    console.log(`  Net worth:         ${fmtUsd(snap.netWorth)}`);
    console.log('');

    const upcoming = schedulesNext30Days(schedules, payees);
    console.log('Scheduled (next 30 days):');
    if (upcoming.length) {
      for (const ln of upcoming) console.log(ln);
    } else {
      console.log('  (none in window)');
    }
    console.log('');

    console.log(`Monthly committed: ${fmtUsd(-committed)}`);
    console.log(
      `Free cash flow:    ${
        Number.isFinite(freeCash)
          ? fmtUsdSignedMonthly(freeCash)
          : 'N/A (set OFF_SEASON_MONTHLY_INCOME)'
      }`,
    );
    console.log('');

    console.log(`Savings runway:    ${runwayDisplay}`);
    console.log('===');
    console.log('');
  } finally {
    await disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
