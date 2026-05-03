import * as api from '@actual-app/api';
import { config } from './config.js';
import {
  applyCategory,
  deleteCategory,
  getAccounts,
  getCategories,
  getPayees,
  transactionPayeeLabel,
} from './actual.js';
import { assertOllamaReachable, getCategorySuggestionFromModel } from './ollama.js';
import { loadMemory } from './memory.js';

/** @typedef {{ id: string, name: string }} CatLite */

/** @typedef {'HIGH'|'MEDIUM'|'LOW'} InferConfidence */

/**
 * Merchant inference buckets (payee text → semantic bucket).
 * @typedef {'DINING_OUT'|'GROCERIES'|'GAS'|'AUTO'|'TRANSPORTATION'|'ENTERTAINMENT'|'SOFTWARE'|'UTILITIES'|'BILLS'|'MOBILE'|'SAVINGS_TRANSFER'|'TRANSFER'|'TRANSFERS'|'INCOME'|'SHOPPING'|'CARD_PAYMENT'|'REIMBURSEMENTS'|'CASH'} PayeeBucket
 */

/** @type {Record<PayeeBucket, string[]>} */
const BUCKET_TO_CATEGORY_NAMES = {
  DINING_OUT: ['Dining Out', 'Restaurants', 'Eating Out', 'Food Out'],
  GROCERIES: ['Groceries'],
  GAS: ['Gas', 'Fuel', 'Auto & Gas'],
  AUTO: ['Auto & Gas', 'Gas', 'Fuel'],
  TRANSPORTATION: ['Transport', 'Transportation', 'Transit'],
  ENTERTAINMENT: ['Entertainment', 'Fun', 'Recreation'],
  SOFTWARE: ['Software', 'Subscriptions', 'Computer'],
  UTILITIES: ['Utilities'],
  BILLS: ['Bills'],
  MOBILE: ['Mobile', 'Phone', 'Cell Phone'],
  SAVINGS_TRANSFER: ['Transfer', 'Savings'],
  TRANSFER: ['Transfer', 'Savings'],
  TRANSFERS: ['Transfers'],
  INCOME: ['Income'],
  SHOPPING: ['Shopping', 'General'],
  CARD_PAYMENT: ['Transfer', 'Credit Card'],
  REIMBURSEMENTS: ['Reimbursements', 'Reimbursement', 'Refunds', 'Disputes'],
  CASH: ['Cash'],
};

const DINING_EXACT = new Set(
  [
    "jack in the box",
    "mcdonald's",
    'mcdonalds',
    'burger king',
    "wendy's",
    'wendys',
    'taco bell',
    'chipotle',
    'subway',
    "domino's",
    'dominos',
    'pizza hut',
    'panda express',
    'in-n-out',
    'in n out',
    "chick-fil-a",
    'chick fil a',
    "denny's",
    'dennys',
    'el pollo loco',
    'troys burgers',
    'covina burgers',
    'boss burger',
    'uber eats',
    'doordash',
    'grubhub',
    'postmates',
    "dick's drive-in",
    'boba tea lounge',
    'little beijing',
    'ding tea',
  ].map((s) => s.toLowerCase()),
);

const GROCERIES_EXACT = new Set(
  [
    'walmart',
    'target',
    'costco',
    'kroger',
    'ralphs',
    'vons',
    "trader joe's",
    'trader joes',
    'whole foods',
    'sprouts',
    'smart & final',
    'safeway',
    'albertsons',
    'aldi',
    'publix',
    'heb',
  ].map((s) => s.toLowerCase()),
);

const GAS_EXACT = new Set(
  ['arco', 'shell', 'chevron', 'bp', 'exxon', 'mobil', '76', 'circle k', 'sai fuel'].map((s) =>
    s.toLowerCase(),
  ),
);

const ENTERTAINMENT_EXACT = new Set(
  [
    'netflix',
    'spotify',
    'hulu',
    'disney+',
    'youtube',
    'twitch',
    'steam',
    'playstation',
    'xbox',
    'nintendo',
    'apple music',
    'amazon prime',
    'hbo',
    'paramount+',
    'peacock',
    'amc theatres',
    'g2a.com',
    'discord',
    'paddle',
    'wizards of coast',
    'wizards of the coast',
  ].map((s) => s.toLowerCase()),
);

const SOFTWARE_EXACT = new Set(
  [
    'cursor',
    'openai',
    'github',
    'vercel',
    'netlify',
    'aws',
    'google cloud',
    'microsoft',
    'adobe',
    'notion',
    'figma',
    'claude.ai',
    'chatgpt',
    'anthropic',
  ].map((s) => s.toLowerCase()),
);

const UTILITIES_EXACT = new Set(
  [
    'so cal gas',
    'southern california edison',
    'at&t',
    'verizon',
    'spectrum',
    'xfinity',
    'cox',
  ].map((s) => s.toLowerCase()),
);

const AUTO_EXACT = new Set(
  [
    'water works express',
    'delta sonic',
    'mister car wash',
    'super star car wash',
    'express car wash',
    'quick quack',
  ].map((s) => s.toLowerCase()),
);

const TRANSPORT_EXACT = new Set(
  [
    'spothere',
    'ladot parking',
    'laparking',
    'parkwhiz',
    'uber',
    'lyft',
    'metro',
    'amtrak',
    'greyhound',
    'alaska airlines',
    'delta',
    'southwest',
    'united airlines',
    'american airlines',
  ].map((s) => s.toLowerCase()),
);

const BILLS_EXACT = new Set(
  ['department of education', 'sallie mae', 'navient'].map((s) => s.toLowerCase()),
);

const MOBILE_EXACT = new Set(
  [
    't-mobile',
    'tmobile',
    'verizon wireless',
    'mint mobile',
    'cricket',
  ].map((s) => s.toLowerCase()),
);

const INCOME_EXACT = new Set(['patreon', 'paypal', 'stripe'].map((s) => s.toLowerCase()));

const SHOPPING_EXACT = new Set(
  [
    'amazon',
    'etsy',
    'ebay',
    'best buy',
    'home depot',
    'ikea',
    'keychron',
    'akko gaming gear',
    'petsmart',
    'dropout store',
    'facer store',
  ].map((s) => s.toLowerCase()),
);

const TRANSFERS_EXACT = new Set(
  [
    'chase credit card',
    'bank of america payment',
    'citi card payment',
    'discover payment',
    'wells fargo payment',
    'capital one payment',
    'american express payment',
    'amex payment',
    'payment',
    'autopay',
  ].map((s) => s.toLowerCase()),
);

const REVERSAL_EXACT = new Set(
  ['reversal scayle payments', 'scayle payments web'].map((s) => s.toLowerCase()),
);

const CASH_EXACT = new Set(
  [
    'atm withdrawal',
    'atm fee',
    'e workman ave west',
    'cash withdrawal',
    'teller withdrawal',
  ].map((s) => s.toLowerCase()),
);

/** Keyword rules: earlier groups win over later (transfer before generic “payment”). */
const KEYWORD_RULES = /** @type {{ bucket: PayeeBucket, keywords: string[], conf: InferConfidence }[]} */ ([
  {
    bucket: 'REIMBURSEMENTS',
    keywords: ['reversal', 'chargeback', 'dispute credit', 'unauthorized return', 'fraud reversal', 'refund'],
    conf: 'HIGH',
  },
  {
    bucket: 'CASH',
    keywords: ['atm', 'cash advance', 'withdrawal', 'teller'],
    conf: 'HIGH',
  },
  {
    bucket: 'TRANSFERS',
    keywords: ['card payment', 'bill payment', 'autopay'],
    conf: 'HIGH',
  },
  {
    bucket: 'SAVINGS_TRANSFER',
    keywords: [
      'online transfer',
      'zelle transfer',
      'venmo',
      'cash app',
      'wire transfer',
      'ach transfer',
    ],
    conf: 'HIGH',
  },
  {
    bucket: 'CARD_PAYMENT',
    keywords: [
      'chase credit',
      'credit card payment',
      'card payment',
      'payment - thank',
      'autopay card',
    ],
    conf: 'MEDIUM',
  },
  { bucket: 'INCOME', keywords: ['direct deposit', 'payroll', 'deposit check', 'statement credit'], conf: 'HIGH' },
  { bucket: 'MOBILE', keywords: ['t-mobile', 'tmobile', 'verizon wireless', 'mint mobile'], conf: 'HIGH' },
  {
    bucket: 'TRANSPORTATION',
    keywords: [
      'parking',
      'garage',
      'valet',
      'transit',
      'rideshare',
      'airline',
      'airways',
      'airport',
    ],
    conf: 'HIGH',
  },
  { bucket: 'DINING_OUT', keywords: [
      'burger',
      'pizza',
      'taco',
      'sushi',
      'grill',
      'cafe',
      'diner',
      'bistro',
      'kitchen',
      'bbq',
      'wings',
      'noodle',
      'ramen',
      'boba',
      'smoothie',
      'sandwich',
      'deli',
      'bakery',
      'donut',
      'ice cream',
    ], conf: 'HIGH' },
  {
    bucket: 'GROCERIES',
    keywords: ['market', 'grocery', 'supermarket', 'foods'],
    conf: 'MEDIUM',
  },
  { bucket: 'GAS', keywords: ['fuel', 'gas station', 'petrol'], conf: 'HIGH' },
  { bucket: 'AUTO', keywords: ['car wash', 'auto wash', 'auto spa', 'detailing'], conf: 'HIGH' },
  {
    bucket: 'ENTERTAINMENT',
    keywords: ['gaming', 'games', 'theatre', 'theater', 'cinema', 'streaming'],
    conf: 'MEDIUM',
  },
  {
    bucket: 'SOFTWARE',
    keywords: ['software', 'saas', 'subscription', 'hosting', 'cloud', 'usage apr', 'usage month'],
    conf: 'MEDIUM',
  },
  {
    bucket: 'UTILITIES',
    keywords: ['electric', 'water', 'gas bill', 'internet', 'utility'],
    conf: 'MEDIUM',
  },
  { bucket: 'BILLS', keywords: ['loan', 'mortgage', 'insurance', 'interest'], conf: 'MEDIUM' },
  {
    bucket: 'SHOPPING',
    keywords: ['store', 'shop', 'retail', 'online purchase'],
    conf: 'LOW',
  },
]);

const EXACT_RULES = /** @type { { set: Set<string>, bucket: PayeeBucket, conf: InferConfidence }[]} */ ([
  { set: REVERSAL_EXACT, bucket: 'REIMBURSEMENTS', conf: 'HIGH' },
  { set: CASH_EXACT, bucket: 'CASH', conf: 'HIGH' },
  { set: TRANSFERS_EXACT, bucket: 'TRANSFERS', conf: 'HIGH' },
  { set: DINING_EXACT, bucket: 'DINING_OUT', conf: 'HIGH' },
  { set: GROCERIES_EXACT, bucket: 'GROCERIES', conf: 'HIGH' },
  { set: TRANSPORT_EXACT, bucket: 'TRANSPORTATION', conf: 'HIGH' },
  { set: GAS_EXACT, bucket: 'GAS', conf: 'HIGH' },
  { set: AUTO_EXACT, bucket: 'AUTO', conf: 'HIGH' },
  { set: ENTERTAINMENT_EXACT, bucket: 'ENTERTAINMENT', conf: 'HIGH' },
  { set: SOFTWARE_EXACT, bucket: 'SOFTWARE', conf: 'HIGH' },
  { set: UTILITIES_EXACT, bucket: 'UTILITIES', conf: 'HIGH' },
  { set: BILLS_EXACT, bucket: 'BILLS', conf: 'HIGH' },
  { set: MOBILE_EXACT, bucket: 'MOBILE', conf: 'HIGH' },
  { set: INCOME_EXACT, bucket: 'INCOME', conf: 'HIGH' },
  { set: SHOPPING_EXACT, bucket: 'SHOPPING', conf: 'HIGH' },
]);

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizePayeeKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Infer spending category from payee / merchant text using a static knowledge base.
 * Exact matches beat keywords; first keyword rule wins.
 *
 * @param {string} payeeName
 * @returns {{ category: PayeeBucket, confidence: InferConfidence, label: string } | null}
 */
export function inferCategoryFromPayee(payeeName) {
  const n = normalizePayeeKey(payeeName);
  if (!n) return null;

  for (const rule of EXACT_RULES) {
    if (rule.set.has(n)) {
      return { category: rule.bucket, confidence: rule.conf, label: displayLabelForBucket(rule.bucket) };
    }
  }

  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (n.includes(kw.toLowerCase())) {
        return { category: rule.bucket, confidence: rule.conf, label: displayLabelForBucket(rule.bucket) };
      }
    }
  }

  return null;
}

/**
 * @param {PayeeBucket} bucket
 * @returns {string}
 */
function displayLabelForBucket(bucket) {
  const labels = {
    DINING_OUT: 'Dining Out',
    GROCERIES: 'Groceries',
    GAS: 'Gas',
    AUTO: 'Auto & Gas',
    TRANSPORTATION: 'Transportation',
    ENTERTAINMENT: 'Entertainment',
    SOFTWARE: 'Software',
    UTILITIES: 'Utilities',
    BILLS: 'Bills',
    MOBILE: 'Mobile',
    SAVINGS_TRANSFER: 'Savings/Transfer',
    TRANSFER: 'Transfer',
    INCOME: 'Income',
    SHOPPING: 'Shopping',
    CARD_PAYMENT: 'Transfer',
    TRANSFERS: 'Transfers',
    REIMBURSEMENTS: 'Reimbursements',
    CASH: 'Cash',
  };
  return labels[bucket] ?? bucket;
}

/**
 * Strip trailing "(group)" from category display names.
 * @param {string} name
 * @returns {string}
 */
function stripCategoryGroupSuffix(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeCategoryNameForMatch(name) {
  return stripCategoryGroupSuffix(name).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * True when payee inference matches how the transaction is already categorized.
 *
 * @param {{ category: PayeeBucket, label: string }} inf
 * @param {string} assignedCategoryName
 * @returns {boolean}
 */
export function inferredMatchesCurrentCategory(inf, assignedCategoryName) {
  const cat = normalizeCategoryNameForMatch(assignedCategoryName);
  const lbl = normalizeCategoryNameForMatch(inf.label);

  if (cat === lbl) return true;

  if (inf.category === 'REIMBURSEMENTS') {
    if (/\breimbursement|\brefunds?\b|\bdisputes?\b|\breversal\b/i.test(cat)) return true;
  }

  if (inf.category === 'TRANSFERS' && /\btransfers?\b/i.test(cat)) return true;

  const savingsLike = (s) =>
    s === 'savings' ||
    s === 'transfer' ||
    /savings\/?\s*transfer/.test(s) ||
    (s.includes('savings') && !s.includes('loan'));

  if (
    (inf.category === 'SAVINGS_TRANSFER' || inf.category === 'TRANSFER' || inf.category === 'CARD_PAYMENT') &&
    savingsLike(cat)
  ) {
    return true;
  }
  if (lbl === 'transfer' && savingsLike(cat)) return true;
  if (lbl === 'savings/transfer' && savingsLike(cat)) return true;

  if (inf.category === 'SHOPPING' && (cat.includes('shopping') || cat.includes('general'))) return true;

  if (inf.category === 'INCOME' && cat === 'income') return true;

  if (
    inf.category === 'TRANSPORTATION' &&
    (cat.includes('transport') || cat.includes('transit') || cat.includes('transportation'))
  ) {
    return true;
  }

  if (inf.category === 'MOBILE' && (cat.includes('bill') || cat.includes('mobile'))) return true;

  if (
    inf.category === 'DINING_OUT' &&
    (cat.includes('dining') || cat.includes('restaurant'))
  ) {
    return true;
  }

  if (
    inf.category === 'ENTERTAINMENT' &&
    (cat.includes('entertainment') || cat.includes('fun') || cat.includes('leisure'))
  ) {
    return true;
  }

  if (
    (inf.category === 'GAS' || inf.category === 'AUTO') &&
    ((cat.includes('auto') && cat.includes('gas')) || /^gas$/.test(cat) || cat.includes('fuel'))
  ) {
    return true;
  }

  if (inf.category === 'UTILITIES' && cat.includes('utilities')) return true;

  if (inf.category === 'GROCERIES' && cat.includes('grocer')) return true;

  if (inf.category === 'SOFTWARE' && cat.includes('software')) return true;

  if (inf.category === 'BILLS' && cat.includes('bill')) return true;

  if (inf.category === 'CASH' && /\bcash\b/i.test(cat)) return true;

  return false;
}

/**
 * @param {CatLite[]} categories
 * @param {PayeeBucket} bucket
 * @returns {{ id: string, name: string } | null}
 */
export function resolveBudgetCategoryForBucket(categories, bucket) {
  const names = BUCKET_TO_CATEGORY_NAMES[bucket] ?? [];
  for (const nm of names) {
    const found = findCatByName(categories, nm);
    if (found) return found;
  }
  for (const c of categories) {
    const lower = c.name.toLowerCase();
    for (const nm of names) {
      if (lower.includes(nm.toLowerCase()) || nm.toLowerCase().includes(lower)) {
        return c;
      }
    }
  }

  if (bucket === 'MOBILE') {
    const bills = findCatByName(categories, 'Bills');
    if (bills) return bills;
  }

  if (bucket === 'TRANSFER') {
    const bills = findCatByName(categories, 'Bills');
    if (bills) return bills;
  }

  if (bucket === 'TRANSFERS') {
    const tr = findCatByName(categories, 'Transfers');
    if (tr) return tr;
  }

  return null;
}

/**
 * Primary semantic bucket implied by a budget category *name* (not payees).
 * @param {string} categoryName
 * @returns {PayeeBucket | null}
 */
export function inferPrimaryBucketFromCategoryName(categoryName) {
  const n = String(categoryName || '')
    .toLowerCase()
    .trim();
  if (!n) return null;
  if (/\butilities\b|\butility\b|\belectric\b|\bwater bill\b|\binternet\b/.test(n)) return 'UTILITIES';
  if (/\bauto\b.*\bgas\b|\bgas\b.*\bauto\b|\bgas\b|\bfuel\b/.test(n)) return 'GAS';
  if (/\bgroceries\b|\bgrocery\b|\bsupermarket\b/.test(n)) return 'GROCERIES';
  if (/\bdining\b|\brestaurant\b|\beats\b|\bfood out\b/.test(n)) return 'DINING_OUT';
  if (/\bentertainment\b|\bstreaming\b|\bfun\b/.test(n)) return 'ENTERTAINMENT';
  if (/\bsoftware\b|\bsubscriptions\b/.test(n)) return 'SOFTWARE';
  if (/\bbills\b|\bmortgage\b(?!.*utility)/.test(n) && !/\butilities\b/.test(n)) return 'BILLS';
  if (/\bmobile\b|\bphone\b|\bcell\b/.test(n)) return 'MOBILE';
  if (/\btransfers\b/i.test(n)) return 'TRANSFERS';
  if (n === 'cash') return 'CASH';
  if (/\btransfer\b|\bsavings\b/.test(n)) return 'SAVINGS_TRANSFER';
  if (/\bshopping\b|\bgeneral\b/.test(n)) return 'SHOPPING';
  if (/\breimbursement|\brefunds?\b|\bdisputes?\b/i.test(n)) return 'REIMBURSEMENTS';
  if (n === 'food' || /^\s*food\s*$/.test(n)) return null;
  return null;
}

/**
 * Buckets allowed for transactions filed under this category name (contamination = infer ∉ allowed).
 * @param {string} categoryName
 * @returns {Set<PayeeBucket> | null} null → do not flag strong contamination from name alone
 */
function allowedBucketsForCategoryName(categoryName) {
  const n = String(categoryName || '')
    .toLowerCase()
    .trim();
  if (!n) return null;
  if (/\butilities\b|\butility\b/.test(n)) return new Set(['UTILITIES']);
  if (/\bauto\b.*\bgas\b|\bgas\b.*\bauto\b/.test(n) || /^gas$/i.test(n.trim())) {
    return new Set(['GAS', 'AUTO']);
  }
  if (/\bshopping\b/.test(n)) return new Set(['SHOPPING']);
  if (/\bincome\b/.test(n)) return new Set(['INCOME']);
  if (n === 'cash') return new Set(['CASH']);
  if (/\btransport|\btransit\b|\btransportation\b/.test(n)) {
    return new Set(['TRANSPORTATION']);
  }
  if (/\btransfers\b/i.test(n)) {
    return new Set(['TRANSFERS', 'TRANSFER', 'CARD_PAYMENT', 'SAVINGS_TRANSFER']);
  }
  if (/\bsavings\b|\btransfer\b/.test(n)) {
    return new Set(['SAVINGS_TRANSFER', 'TRANSFER', 'CARD_PAYMENT']);
  }
  if (/\bentertainment\b|\bstreaming\b|\bleisure\b|\bfun\b/.test(n)) {
    return new Set(['ENTERTAINMENT']);
  }
  if (/\bgroceries\b|\bgrocery\b/.test(n)) return new Set(['GROCERIES']);
  if (/\bdining\b|\brestaurant\b/.test(n)) return new Set(['DINING_OUT']);
  if (/\bsoftware\b/.test(n)) return new Set(['SOFTWARE']);
  if (/\bbills\b/.test(n) && !/\butilities\b/.test(n)) {
    return new Set(['BILLS', 'MOBILE']);
  }
  if (/\breimbursement|\brefunds?\b|\bdisputes?\b/i.test(n)) {
    return new Set(['REIMBURSEMENTS']);
  }
  if (n === 'food' || /^\s*food\s*$/i.test(n)) {
    return new Set(['GROCERIES', 'DINING_OUT']);
  }
  return null;
}

/**
 * @param {PayeeBucket} inferBucket
 * @param {Set<PayeeBucket> | null} allowed
 * @returns {boolean}
 */
function inferAllowedInCategory(inferBucket, allowed) {
  if (!allowed) return true;
  if (allowed.has(inferBucket)) return true;
  if (inferBucket === 'TRANSFER' && allowed.has('SAVINGS_TRANSFER')) return true;
  if (inferBucket === 'SAVINGS_TRANSFER' && allowed.has('TRANSFER')) return true;
  if (inferBucket === 'TRANSFERS' && allowed.has('TRANSFER')) return true;
  if (inferBucket === 'TRANSFER' && allowed.has('TRANSFERS')) return true;
  if (inferBucket === 'CARD_PAYMENT' && allowed.has('TRANSFERS')) return true;
  return false;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * @param {string} catName
 * @param {string} alias
 * @returns {boolean}
 */
function catMatchesAlias(catName, alias) {
  const n = catName.toLowerCase().trim().replace(/\s+/g, ' ');
  const a = alias.toLowerCase().trim();
  if (!n || !a) return false;
  if (n === a) return true;
  if (n.includes(a)) return true;
  return false;
}

const SEMANTIC_GROUPS = [
  {
    aliases: ['food', 'groceries', 'supermarket', 'market'],
    canonical: 'Groceries',
  },
  {
    aliases: ['dining', 'eating out', 'restaurants', 'food out'],
    canonical: 'Dining Out',
  },
  { aliases: ['gas', 'fuel', 'petrol', 'gasoline'], canonical: 'Gas' },
  {
    aliases: ['fun', 'leisure', 'entertainment', 'streaming'],
    canonical: 'Entertainment',
  },
  {
    aliases: ['transport', 'transit', 'uber', 'lyft', 'commute'],
    canonical: 'Transport',
  },
  {
    aliases: ['bills', 'utilities', 'electric', 'water', 'internet'],
    canonical: 'Utilities',
  },
];

/**
 * @param {CatLite[]} categories
 * @param {string} name
 * @returns {CatLite | undefined}
 */
function findCatByName(categories, name) {
  const t = String(name).trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === t);
}

/**
 * Build transaction counts per category id across open accounts.
 * @param {object[]} accounts
 * @returns {Promise<Map<string, number>>}
 */
export async function countTransactionsByCategory(accounts) {
  const map = new Map();
  for (const acc of accounts) {
    if (acc.closed) continue;
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    for (const t of txs) {
      if (t.category == null || t.category === '') continue;
      map.set(t.category, (map.get(t.category) || 0) + 1);
    }
  }
  return map;
}

/**
 * @param {CatLite[]} list
 * @returns {object[]}
 */
function computeBaseRedundantPairs(list) {
  /** @type {object[]} */
  const out = [];
  const removedIds = new Set();

  for (const c of list) {
    for (const group of SEMANTIC_GROUPS) {
      const aliasHit = group.aliases.some((al) => catMatchesAlias(c.name, al));
      if (!aliasHit) continue;
      const keep = list.find((k) => k.name.toLowerCase() === group.canonical.toLowerCase());
      if (!keep || keep.id === c.id) break;
      if (removedIds.has(c.id)) break;
      removedIds.add(c.id);
      out.push({
        candidates: [c.name, keep.name].sort(),
        suggestedKeep: keep.name,
        suggestedRemove: c.name,
        reason: `semantic similarity — alias maps to canonical "${group.canonical}"`,
        removeId: c.id,
        keepId: keep.id,
      });
      break;
    }
  }

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (removedIds.has(a.id) || removedIds.has(b.id)) continue;
      const d = levenshtein(a.name.toLowerCase(), b.name.toLowerCase());
      if (d === 0 || d >= 3) continue;

      let remove;
      let keep;
      if (a.name.length < b.name.length) {
        remove = a;
        keep = b;
      } else if (b.name.length < a.name.length) {
        remove = b;
        keep = a;
      } else if (a.name.localeCompare(b.name) < 0) {
        remove = a;
        keep = b;
      } else {
        remove = b;
        keep = a;
      }

      if (removedIds.has(remove.id)) continue;
      removedIds.add(remove.id);
      out.push({
        candidates: [a.name, b.name].sort(),
        suggestedKeep: keep.name,
        suggestedRemove: remove.name,
        reason: `name similarity (Levenshtein distance ${d})`,
        removeId: remove.id,
        keepId: keep.id,
      });
    }
  }

  return out;
}

/**
 * @param {string} name
 */
function isMergeProtectedCategoryName(name) {
  const n = String(name || '').trim().toLowerCase();
  return n === 'transfers' || n === 'transfer' || n === 'reimbursements';
}

let warnedMissingReimbursementsCategory = false;

/**
 * Warn once if reversal-like payees exist but no budget category maps for Reimbursements.
 *
 * @param {{ id: string, name: string }[]} categories
 * @param {string[]} payeeSamples
 */
export function warnIfReversalPayeesWithoutReimbursementsCategory(categories, payeeSamples) {
  const catLite = categories.map((c) => ({ id: c.id, name: c.name }));
  if (resolveBudgetCategoryForBucket(catLite, 'REIMBURSEMENTS')) return;

  for (const payee of payeeSamples) {
    const inf = inferCategoryFromPayee(payee);
    if (inf?.category === 'REIMBURSEMENTS') {
      if (!warnedMissingReimbursementsCategory) {
        warnedMissingReimbursementsCategory = true;
        console.warn(
          'Note: Reversal transactions found but no Reimbursements category exists. Create it in Actual Budget and run npm run fix-specific to move them.',
        );
      }
      return;
    }
  }
}

/**
 * Weight payee-inferred buckets for the "remove" side of a redundant pair.
 * @param {object} pair
 * @param {Map<string, object>} metricsById
 * @param {CatLite[]} categories
 */
function attachPayeeInferenceToPair(pair, metricsById, categories) {
  const removeM = metricsById.get(pair.removeId);
  const total = removeM?.count ?? 0;
  /** @type {Map<PayeeBucket, number>} */
  const bucketWeights = new Map();

  for (const [payee, cnt] of removeM?.payeeCount ?? []) {
    const inf = inferCategoryFromPayee(payee);
    if (inf) {
      bucketWeights.set(inf.category, (bucketWeights.get(inf.category) || 0) + cnt);
    }
  }

  const sorted = [...bucketWeights.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const topFrac = total > 0 && top ? top[1] / total : 0;
  const keepBucket = inferPrimaryBucketFromCategoryName(pair.suggestedKeep);
  const dominantBucket = top?.[0] ?? null;
  const dominantLabel = dominantBucket ? displayLabelForBucket(dominantBucket) : '';

  const resolved =
    dominantBucket != null ? resolveBudgetCategoryForBucket(categories, dominantBucket) : null;

  let payeeAnalysisLine = '';
  let recommendation = /** @type {'MERGE'|'RECATEGORIZE'|'REVIEW'|null} */ (null);
  let confidence = /** @type {'High'|'Medium'|'Low'} */ ('Medium');

  if (total > 0 && top && topFrac >= 0.7) {
    payeeAnalysisLine = `${top[1]}/${total} transactions in "${pair.suggestedRemove}" infer to ${dominantLabel}`;
    if (keepBucket && dominantBucket === keepBucket) {
      recommendation = 'MERGE';
      confidence = 'High';
    } else if (dominantBucket && (!keepBucket || dominantBucket !== keepBucket)) {
      recommendation = 'RECATEGORIZE';
      confidence = 'High';
      payeeAnalysisLine = `${top[1]}/${total} transactions in "${pair.suggestedRemove}" infer to ${dominantLabel} (not "${pair.suggestedKeep}")`;
    }
  } else if (total > 0 && top && topFrac >= 0.5 && keepBucket && dominantBucket && dominantBucket !== keepBucket) {
    payeeAnalysisLine = `Payee analysis: plurality (${Math.round(topFrac * 100)}%) infer ${dominantLabel} vs "${pair.suggestedKeep}" (${keepBucket})`;
    recommendation = 'RECATEGORIZE';
    confidence = 'Medium';
  } else if (total > 0) {
    const labeled = [...bucketWeights.values()].reduce((s, v) => s + v, 0);
    payeeAnalysisLine = `Payee analysis: ${labeled}/${total} transactions match merchant rules; top signal ${dominantLabel || 'none'} (${Math.round(topFrac * 100)}%)`;
  }

  return {
    ...pair,
    payeeInference: {
      dominantBucket,
      dominantLabel,
      fraction: topFrac,
      targetCategoryId: resolved?.id ?? null,
      targetCategoryName: resolved?.name ?? null,
      payeeAnalysisLine,
      recommendation,
      confidence,
      keepBucket,
    },
  };
}

/**
 * Heuristic redundant category pairs (semantic aliases + Levenshtein distance under 3).
 * Optionally enriched with payee-based merge vs recategorize signals.
 *
 * @param {object[] | CatLite[]} categories — entities with id and name
 * @param {Map<string, object> | null} [metricsById]
 * @returns {Promise<object[]>}
 */
export async function findRedundantCategories(categories, metricsById = null) {
  const list = categories.map((c) => ({
    id: c.id,
    name: c.name,
  }));

  const base = computeBaseRedundantPairs(list).filter(
    (p) =>
      !isMergeProtectedCategoryName(p.suggestedRemove) &&
      !isMergeProtectedCategoryName(p.suggestedKeep),
  );
  if (!metricsById) return base;

  const catLite = list.map((c) => ({ id: c.id, name: c.name }));
  return base.map((p) => attachPayeeInferenceToPair(p, metricsById, catLite));
}

/** Categories with fewer than this many transactions are flagged as "thin". */
const THIN_CATEGORY_MAX_TX = 4;

/**
 * @param {number} cents
 * @returns {number}
 */
function absDollarsFromCents(cents) {
  return Math.abs(Number(cents) || 0) / 100;
}

/**
 * @param {number} dollars
 * @returns {string}
 */
function formatMoneyUsd(dollars) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

/**
 * @param {Date | null} d
 * @returns {string}
 */
function formatMonthYear(d) {
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * @param {string | undefined} raw
 * @returns {Date | null}
 */
function txToDate(raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Map<string, number>} payeeCount
 * @param {number} n
 * @returns {[string, number][]}
 */
function topPayees(payeeCount, n) {
  return [...payeeCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

/**
 * @param {Map<string, number>} payeeCount
 * @param {number} n
 * @returns {string}
 */
function formatTopPayeesLine(payeeCount, n) {
  const top = topPayees(payeeCount, n);
  if (top.length === 0) return '(none)';
  return top.map(([p, c]) => `${p} (${c})`).join(', ');
}

/**
 * Load all transactions once, bucket by category and uncategorized.
 * @param {object[]} accounts
 * @param {Map<string, string>} payeeById
 * @returns {Promise<{
 *   byCategory: Map<string, { txs: object[], payeeCount: Map<string, number> }>,
 *   uncategorized: { tx: object, accountName: string }[],
 * }>}
 */
export async function loadTransactionsGrouped(accounts, payeeById) {
  /** @type {Map<string, { txs: object[], payeeCount: Map<string, number> }>} */
  const byCategory = new Map();
  /** @type {{ tx: object, accountName: string }[]} */
  const uncategorized = [];

  for (const acc of accounts) {
    if (acc.closed) continue;
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    for (const t of txs) {
      const payee = transactionPayeeLabel(t, payeeById);
      if (t.category == null || t.category === '') {
        uncategorized.push({ tx: t, accountName: acc.name ?? '(account)' });
        continue;
      }
      if (!byCategory.has(t.category)) {
        byCategory.set(t.category, { txs: [], payeeCount: new Map() });
      }
      const bucket = byCategory.get(t.category);
      bucket.txs.push(t);
      bucket.payeeCount.set(payee, (bucket.payeeCount.get(payee) || 0) + 1);
    }
  }

  return { byCategory, uncategorized };
}

/**
 * @param {object} categoryRow — from getCategories()
 * @param {{ txs: object[], payeeCount: Map<string, number> }} bucket
 * @returns {object}
 */
function buildCategoryMetrics(categoryRow, bucket) {
  const txs = bucket.txs;
  const payeeCount = bucket.payeeCount;
  let totalAbs = 0;
  /** @type {Date | null} */
  let minD = null;
  /** @type {Date | null} */
  let maxD = null;

  for (const t of txs) {
    totalAbs += absDollarsFromCents(t.amount);
    const d = txToDate(t.date);
    if (d) {
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    }
  }

  const count = txs.length;
  const avg = count > 0 ? totalAbs / count : 0;

  const groupLabel = String(categoryRow.group_name ?? categoryRow.groupName ?? '').trim();
  const displayName = groupLabel ? `${categoryRow.name} (${groupLabel})` : categoryRow.name;

  const baseName = stripCategoryGroupSuffix(categoryRow.name);
  /** @type {{ charges: number, reversals: number, net: number } | null} */
  let reimbursementBreakdown = null;
  if (/^reimbursements$/i.test(String(baseName).trim())) {
    let charges = 0;
    let reversals = 0;
    for (const t of txs) {
      const amt = Number(t.amount) / 100;
      if (amt < 0) charges += -amt;
      else if (amt > 0) reversals += amt;
    }
    reimbursementBreakdown = { charges, reversals, net: reversals - charges };
  }

  return {
    id: categoryRow.id,
    name: categoryRow.name,
    displayName,
    count,
    totalAbsDollars: totalAbs,
    minDate: minD,
    maxDate: maxD,
    avgDollars: avg,
    payeeCount,
    topPayees: topPayees(payeeCount, 5),
    reimbursementBreakdown,
  };
}

/**
 * @param {object} pair — from findRedundantCategories
 * @param {object} removeM
 * @param {object} keepM
 * @returns {{ shared: { payee: string, removeCount: number, keepCount: number }[], recommendation: string, confidence: string, detail: string }}
 */
function analyzeRedundantPairOverlap(pair, removeM, keepM) {
  const a = removeM.payeeCount;
  const b = keepM.payeeCount;
  /** @type { { payee: string, removeCount: number, keepCount: number }[]} */
  const shared = [];
  for (const [payee, ca] of a) {
    const cb = b.get(payee);
    if (cb) shared.push({ payee, removeCount: ca, keepCount: cb });
  }
  shared.sort((x, y) => y.removeCount + y.keepCount - (x.removeCount + x.keepCount));

  const reasonStr = String(pair.reason ?? '');
  const isSemantic = reasonStr.startsWith('semantic');
  const levMatch = reasonStr.match(/Levenshtein distance (\d+)/);
  const lev = levMatch ? parseInt(levMatch[1], 10) : null;

  let recommendation = 'REVIEW';
  let confidence = 'Medium';
  let detail = '';

  if (shared.length > 0) {
    const lines = shared.slice(0, 5).map(
      (s) =>
        `Warning: ${s.payee} appears in both ${pair.suggestedRemove} (${s.removeCount}x) and ${pair.suggestedKeep} (${s.keepCount}x) — same merchant split across two categories`,
    );
    detail = lines.join('\n');
  }

  if (isSemantic && shared.length >= 2) {
    recommendation = 'MERGE';
    confidence = 'High';
  } else if (isSemantic && shared.length === 1) {
    recommendation = 'MERGE';
    confidence = 'High';
  } else if (isSemantic && shared.length === 0) {
    recommendation = 'REVIEW';
    confidence = 'Medium';
  } else if (lev != null && lev <= 1 && shared.length >= 1) {
    recommendation = 'MERGE';
    confidence = lev === 1 && shared.length >= 2 ? 'High' : 'Medium';
  } else if (lev != null && lev === 2 && shared.length >= 1) {
    recommendation = 'REVIEW';
    confidence = 'Medium';
  } else if (lev != null && shared.length === 0) {
    recommendation = 'KEEP SEPARATE';
    confidence = 'Low';
  }

  return { shared, recommendation, confidence, detail };
}

/**
 * @param {string} thinCatId
 * @param {object[]} redundantPairs
 * @param {Map<string, object>} metricsById
 * @returns {string}
 */
function thinCategorySuggestion(thinCatId, redundantPairs, metricsById) {
  const m = metricsById.get(thinCatId);
  if (m && m.count === 0) return 'delete';
  for (const r of redundantPairs) {
    if (r.removeId === thinCatId) {
      return `merge into ${r.suggestedKeep}`;
    }
  }
  return 'review';
}

/**
 * @param {Map<string, Map<string, number>>} payeeToCategoryCounts
 * @param {Map<string, string>} catIdToName
 * @param {Set<string>} redundantUndirectedKeys — "idA::idB" with idA < idB
 * @returns {{ payee: string, parts: string, tag: string }[]}
 */
function computePayeeConsistencyRows(payeeToCategoryCounts, catIdToName, redundantUndirectedKeys) {
  /** @type {{ payee: string, parts: string, tag: string }[]} */
  const rows = [];

  for (const [payee, catMap] of payeeToCategoryCounts) {
    if (catMap.size < 2) continue;

    const entries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    const parts = entries
      .map(([cid, cnt]) => `${catIdToName.get(cid) ?? cid} (${cnt}x)`)
      .join(', ');

    let tag = 'REVIEW';
    if (entries.length >= 3) {
      tag = 'INCONSISTENT';
    } else if (entries.length === 2) {
      const [idA, nA] = entries[0];
      const [idB, nB] = entries[1];
      const k = idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
      const bothMaterial = nA >= 3 && nB >= 3;
      if (redundantUndirectedKeys.has(k) || bothMaterial) tag = 'INCONSISTENT';
    }

    rows.push({ payee, parts, tag });
  }

  rows.sort((a, b) => {
    const rank = (t) => (t === 'INCONSISTENT' ? 0 : 1);
    const d = rank(a.tag) - rank(b.tag);
    if (d !== 0) return d;
    return a.payee.localeCompare(b.payee);
  });

  return rows;
}

/**
 * @param {object} pair
 * @param {object | undefined} removeM
 * @param {object | undefined} keepM
 */
function mergeOverlapWithInference(pair, removeM, keepM) {
  const base = analyzeRedundantPairOverlap(
    pair,
    removeM ?? { payeeCount: new Map() },
    keepM ?? { payeeCount: new Map() },
  );
  const pinf = pair.payeeInference;
  if (!pinf?.recommendation) return base;

  const detail = [pinf.payeeAnalysisLine, base.detail].filter(Boolean).join('\n');
  return {
    ...base,
    recommendation: pinf.recommendation,
    confidence: pinf.confidence,
    detail,
  };
}

/**
 * @param {Map<string, object>} metricsById
 */
function buildContaminationReport(metricsById) {
  /** @type {object[]} */
  const sections = [];
  let totalContaminatedTx = 0;

  for (const m of metricsById.values()) {
    if (/^reimbursements$/i.test(String(m.name || '').trim())) continue;

    const allowed = allowedBucketsForCategoryName(m.name);
    /** @type { { payee: string, count: number, inf: NonNullable<ReturnType<typeof inferCategoryFromPayee>>, severity: string }[]} */
    const mismatches = [];

    for (const [payee, cnt] of m.payeeCount) {
      const inf = inferCategoryFromPayee(payee);
      if (!inf) continue;

      if (inferredMatchesCurrentCategory(inf, m.name)) continue;

      if (!allowed) {
        if (inf.confidence === 'HIGH') {
          mismatches.push({ payee, count: cnt, inf, severity: 'MEDIUM' });
        }
        continue;
      }
      if (inferAllowedInCategory(inf.category, allowed)) continue;

      let severity = 'MEDIUM';
      if (
        inf.confidence === 'HIGH' &&
        [
          'ENTERTAINMENT',
          'MOBILE',
          'SAVINGS_TRANSFER',
          'SOFTWARE',
          'GAS',
          'TRANSFER',
          'TRANSPORTATION',
          'REIMBURSEMENTS',
          'TRANSFERS',
          'CASH',
        ].includes(inf.category)
      ) {
        severity = 'HIGH';
      } else if (inf.confidence === 'LOW') {
        severity = 'LOW';
      }

      mismatches.push({ payee, count: cnt, inf, severity });
    }

    if (mismatches.length === 0) continue;

    const mismatchTxSum = mismatches.reduce((s, x) => s + x.count, 0);
    totalContaminatedTx += mismatchTxSum;

    const catTotal = m.count;
    const headline =
      mismatchTxSum >= catTotal * 0.9 && catTotal > 0
        ? `${m.displayName} (${mismatchTxSum} mismatches — entire category may be miscategorized)`
        : `${m.displayName} (${mismatches.length} mismatch patterns found)`;

    sections.push({
      categoryId: m.id,
      categoryName: m.name,
      displayName: m.displayName,
      mismatches,
      mismatchTxSum,
      catTotal,
      headline,
    });
  }

  return { sections, totalContaminatedTx };
}

/**
 * @param {{ sections: object[], totalContaminatedTx: number }} report
 * @param {object[]} categories
 */
function buildContaminationFixPlan(report, categories) {
  const catLite = categories.map((c) => ({ id: c.id, name: c.name }));
  /** @type {object[]} */
  const fixes = [];
  const seenBulk = new Set();

  for (const sec of report.sections) {
    const byBucket = new Map();
    for (const mm of sec.mismatches) {
      byBucket.set(mm.inf.category, (byBucket.get(mm.inf.category) || 0) + mm.count);
    }
    const ordered = [...byBucket.entries()].sort((a, b) => b[1] - a[1]);
    const top = ordered[0];
    if (top && sec.catTotal > 0 && top[1] / sec.catTotal >= 0.85) {
      const res = resolveBudgetCategoryForBucket(catLite, top[0]);
      if (res) {
        const key = `${sec.categoryId}::bulk::${res.id}`;
        if (!seenBulk.has(key)) {
          seenBulk.add(key);
          fixes.push({
            kind: 'BULK_RECATEGORIZE',
            fromCategoryId: sec.categoryId,
            fromDisplayName: sec.displayName,
            toCategoryId: res.id,
            toName: res.name,
            toLabel: displayLabelForBucket(top[0]),
            txCount: sec.catTotal,
            confidence: 'HIGH',
            bucket: top[0],
          });
        }
        continue;
      }
    }

    for (const mm of sec.mismatches) {
      const res = resolveBudgetCategoryForBucket(catLite, mm.inf.category);
      if (!res) continue;
      fixes.push({
        kind: 'PAYEE_SUBSET',
        fromCategoryId: sec.categoryId,
        fromDisplayName: sec.displayName,
        payee: mm.payee,
        toCategoryId: res.id,
        toName: res.name,
        toLabel: mm.inf.label,
        txCount: mm.count,
        confidence: mm.severity,
      });
    }
  }

  return fixes.sort((a, b) => b.txCount - a.txCount);
}

/**
 * Full category audit (read-only). Call after connect(); uses one transaction scan.
 *
 * @param {object[]} accounts
 * @param {object[]} categories — rows from getCategories()
 * @param {Map<string, string>} payeeById
 * @returns {Promise<object>}
 */
export async function gatherCategoryAuditData(accounts, categories, payeeById) {
  const { byCategory, uncategorized } = await loadTransactionsGrouped(accounts, payeeById);
  const catList = categories.map((c) => ({ id: c.id, name: c.name }));

  /** @type {Map<string, object>} */
  const metricsById = new Map();
  for (const c of categories) {
    const bucket = byCategory.get(c.id) ?? { txs: [], payeeCount: new Map() };
    metricsById.set(c.id, buildCategoryMetrics(c, bucket));
  }

  const contaminationReport = buildContaminationReport(metricsById);
  const contaminationFixPlan = buildContaminationFixPlan(contaminationReport, categories);

  const redundant = await findRedundantCategories(catList, metricsById);

  /** @type {Map<string, Map<string, number>>} */
  const payeeToCategoryCounts = new Map();
  for (const [cid, m] of metricsById) {
    for (const [payee, cnt] of m.payeeCount) {
      if (!payeeToCategoryCounts.has(payee)) {
        payeeToCategoryCounts.set(payee, new Map());
      }
      payeeToCategoryCounts.get(payee).set(cid, cnt);
    }
  }

  const catIdToName = new Map([...metricsById.values()].map((m) => [m.id, m.name]));
  const redundantUndirectedKeys = new Set();
  for (const r of redundant) {
    const a = r.removeId;
    const b = r.keepId;
    const k = a < b ? `${a}::${b}` : `${b}::${a}`;
    redundantUndirectedKeys.add(k);
  }

  const payeeConsistencyRows = computePayeeConsistencyRows(
    payeeToCategoryCounts,
    catIdToName,
    redundantUndirectedKeys,
  );

  const enrichedRedundant = redundant.map((pair) => {
    const removeM = metricsById.get(pair.removeId);
    const keepM = metricsById.get(pair.keepId);
    const overlap = mergeOverlapWithInference(
      pair,
      removeM ?? { payeeCount: new Map() },
      keepM ?? { payeeCount: new Map() },
    );
    const levMatch = String(pair.reason).match(/Levenshtein distance (\d+)/);
    const similarityLabel = String(pair.reason ?? '').startsWith('semantic')
      ? 'semantic alias / canonical group'
      : `name similarity (Levenshtein distance ${levMatch ? levMatch[1] : '?'})`;

    return { pair, overlap, similarityLabel };
  });

  /** @type {object[]} */
  const thinList = [];
  for (const m of metricsById.values()) {
    if (m.count <= THIN_CATEGORY_MAX_TX) {
      thinList.push({
        ...m,
        suggest: thinCategorySuggestion(m.id, redundant, metricsById),
      });
    }
  }
  thinList.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));

  /** @type {string[]} */
  const allPayeeSamples = [];
  for (const m of metricsById.values()) {
    for (const [payee] of m.payeeCount) allPayeeSamples.push(payee);
  }
  warnIfReversalPayeesWithoutReimbursementsCategory(catList, allPayeeSamples);

  /** @type {Map<string, number>} */
  const uncPayeeCounts = new Map();
  /** @type {Map<string, number>} */
  const uncAccountCounts = new Map();
  let uncMin = /** @type {Date | null} */ (null);
  let uncMax = /** @type {Date | null} */ (null);
  for (const { tx, accountName } of uncategorized) {
    uncAccountCounts.set(accountName, (uncAccountCounts.get(accountName) || 0) + 1);
    const payee = transactionPayeeLabel(tx, payeeById);
    uncPayeeCounts.set(payee, (uncPayeeCounts.get(payee) || 0) + 1);
    const d = txToDate(tx.date);
    if (d) {
      if (!uncMin || d < uncMin) uncMin = d;
      if (!uncMax || d > uncMax) uncMax = d;
    }
  }

  return {
    metricsById,
    metricsList: [...metricsById.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    redundant,
    enrichedRedundant,
    uncategorized,
    uncategorizedSummary: {
      count: uncategorized.length,
      accountCounts: uncAccountCounts,
      payeeCounts: uncPayeeCounts,
      minDate: uncMin,
      maxDate: uncMax,
    },
    thinList,
    payeeConsistencyRows,
    payeeToCategoryCounts,
    contaminationReport,
    contaminationFixPlan,
  };
}

/**
 * Print the deep category health report (read-only).
 * @param {Awaited<ReturnType<typeof gatherCategoryAuditData>>} audit
 * @returns {void}
 */
export function printCategoryAuditReport(audit) {
  const {
    metricsList,
    enrichedRedundant,
    thinList,
    payeeConsistencyRows,
    metricsById,
    redundant,
    uncategorizedSummary,
    payeeToCategoryCounts,
    contaminationReport,
    contaminationFixPlan,
  } = audit;

  console.log('');
  console.log('Category Health Report (analyze mode — read-only)');
  console.log('==================================================');

  console.log('');
  console.log('Category Overview');
  console.log('=================');
  for (const m of metricsList) {
    const dateRange =
      m.count === 0
        ? '—'
        : `${formatMonthYear(m.minDate)} - ${formatMonthYear(m.maxDate)}`;
    if (m.reimbursementBreakdown) {
      const r = m.reimbursementBreakdown;
      const line1 = `${m.displayName.padEnd(24)} | ${m.count} transactions | net: ${formatMoneyUsd(
        r.net,
      )} | ${dateRange}`;
      console.log(line1);
      console.log(
        `  (charges: ${formatMoneyUsd(r.charges)}, reversals: ${formatMoneyUsd(r.reversals)})`,
      );
    } else {
      const line1 = `${m.displayName.padEnd(24)} | ${m.count} transactions | ${formatMoneyUsd(
        m.totalAbsDollars,
      )} total | ${dateRange}`;
      console.log(line1);
      const avgStr = m.count > 0 ? formatMoneyUsd(m.avgDollars) : '—';
      const payeePart = formatTopPayeesLine(m.payeeCount, 5);
      console.log(`  Avg: ${avgStr} | Top payees: ${payeePart}`);
    }
    console.log('');
  }

  console.log('');
  console.log('Category Contamination Report');
  console.log('==============================');
  if (!contaminationReport.sections.length) {
    console.log('No obvious merchant/category mismatches detected by rules.');
  } else {
    console.log(
      'Transactions that appear to be in the WRONG category based on merchant knowledge:\n',
    );
    for (const sec of contaminationReport.sections) {
      console.log(`${sec.headline}:`);
      for (const mm of sec.mismatches) {
        const tag = mm.severity === 'HIGH' ? 'should be' : 'may be';
        const conf = mm.severity === 'HIGH' ? 'HIGH' : mm.severity === 'MEDIUM' ? 'MEDIUM' : 'LOW';
        console.log(
          `  ${mm.payee} (${mm.count}x)\t→ ${tag}: ${mm.inf.label}\t[${conf} confidence]`,
        );
      }
      console.log('');
    }
    console.log(`Total contaminated transactions (sum of mismatch rows): ${contaminationReport.totalContaminatedTx}`);
  }

  console.log('');
  console.log('Redundancy Analysis');
  console.log('===================');
  if (enrichedRedundant.length === 0) {
    console.log('No heuristic redundant pairs found.');
  } else {
    enrichedRedundant.forEach((item, i) => {
      const { pair, overlap, similarityLabel } = item;
      const pinf = pair.payeeInference;
      console.log('');
      console.log(`Pair ${i + 1}: ${pair.suggestedRemove} vs ${pair.suggestedKeep}`);
      console.log(`  Why similar: ${similarityLabel}`);
      if (pinf?.payeeAnalysisLine) {
        console.log(`  Payee analysis: ${pinf.payeeAnalysisLine}`);
      }
      if (overlap.recommendation === 'RECATEGORIZE') {
        console.log(
          `  Recommendation: RECATEGORIZE ${pair.suggestedRemove} → ${pinf?.targetCategoryName ?? pinf?.dominantLabel ?? '?'} (not ${pair.suggestedKeep})`,
        );
      } else {
        console.log(`  Recommendation: ${overlap.recommendation}`);
      }
      console.log(`  Confidence: ${overlap.confidence}`);
      if (overlap.detail) {
        console.log(`  Detail:`);
        for (const line of overlap.detail.split('\n')) {
          console.log(`    ${line}`);
        }
      } else if (!pinf?.payeeAnalysisLine) {
        console.log(`  Overlap: no shared payees between these two categories.`);
      }
    });
  }

  console.log('');
  console.log('Thin Categories (< 5 transactions) — consider merging or removing:');
  if (thinList.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of thinList) {
      console.log(`  ${t.displayName}  | ${t.count} transactions  | suggest: ${t.suggest}`);
    }
  }

  console.log('');
  console.log('Uncategorized Summary');
  console.log('=====================');
  console.log(`Uncategorized Transactions: ${uncategorizedSummary.count}`);
  if (uncategorizedSummary.count > 0) {
    const acctLine = [...uncategorizedSummary.accountCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} (${c})`)
      .join(', ');
    console.log(`  Accounts affected: ${acctLine}`);
    const dr =
      uncategorizedSummary.minDate && uncategorizedSummary.maxDate
        ? `${formatMonthYear(uncategorizedSummary.minDate)} - ${formatMonthYear(uncategorizedSummary.maxDate)}`
        : '—';
    console.log(`  Date range: ${dr}`);
    const topUnk = formatTopPayeesLine(uncategorizedSummary.payeeCounts, 8);
    console.log(`  Top unknown payees: ${topUnk}`);
    console.log('  Run: npm start to auto-categorize these');
  }

  console.log('');
  console.log('Payee Consistency Issues (same merchant in multiple categories):');
  if (payeeConsistencyRows.length === 0) {
    console.log('  (none detected)');
  } else {
    for (const row of payeeConsistencyRows) {
      console.log(`  ${row.payee} → ${row.parts}  [${row.tag}]`);
    }
    const inconsistentN = payeeConsistencyRows.filter((r) => r.tag === 'INCONSISTENT').length;
    console.log(`  Total inconsistent payees: ${inconsistentN}`);
  }

  /** @type {string[]} */
  const highPri = [];
  /** @type {string[]} */
  const medPri = [];
  /** @type {string[]} */
  const lowPri = [];

  for (const item of enrichedRedundant) {
    const { pair, overlap } = item;
    const rm = metricsById.get(pair.removeId);
    const n = rm?.count ?? 0;
    const pinf = pair.payeeInference;
    if (overlap.recommendation === 'RECATEGORIZE' && overlap.confidence === 'High') {
      highPri.push(
        `Recategorize all ${n} "${pair.suggestedRemove}" transactions → ${pinf?.dominantLabel ?? pinf?.targetCategoryName ?? 'target'} (payee rules — not "${pair.suggestedKeep}")`,
      );
    } else if (overlap.recommendation === 'MERGE' && overlap.confidence === 'High') {
      highPri.push(
        `Merge ${pair.suggestedRemove} (${n} tx) into ${pair.suggestedKeep} — payees align with "${pair.suggestedKeep}"`,
      );
    } else if (overlap.recommendation === 'MERGE') {
      medPri.push(
        `Merge ${pair.suggestedRemove} (${n} tx) into ${pair.suggestedKeep} — ${String(pair.reason ?? '').startsWith('semantic') ? 'semantic duplicate' : 'similar names'}`,
      );
    } else if (overlap.recommendation === 'REVIEW' || overlap.recommendation === 'RECATEGORIZE') {
      medPri.push(`Review pair ${pair.suggestedRemove} vs ${pair.suggestedKeep} (${overlap.confidence} confidence)`);
    }
  }

  if (contaminationFixPlan?.length) {
    for (const fix of contaminationFixPlan) {
      if (fix.confidence !== 'HIGH') continue;
      if (fix.kind === 'BULK_RECATEGORIZE') {
        highPri.push(
          `Recategorize all ${fix.txCount} "${fix.fromDisplayName}" transactions → ${fix.toLabel}`,
        );
      } else if (fix.kind === 'PAYEE_SUBSET') {
        highPri.push(`Move ${fix.payee} (${fix.txCount}x) from ${fix.fromDisplayName} → ${fix.toLabel}`);
      }
    }
  }

  const payeeBad = payeeConsistencyRows.filter((r) => r.tag === 'INCONSISTENT');
  for (const row of payeeBad) {
    const nCat = payeeToCategoryCounts.get(row.payee)?.size ?? 0;
    highPri.push(`Fix ${row.payee} split across ${nCat} categories — pick one`);
  }

  if (contaminationFixPlan?.length) {
    for (const fix of contaminationFixPlan) {
      if (fix.confidence !== 'MEDIUM') continue;
      if (fix.kind === 'PAYEE_SUBSET') {
        medPri.push(
          `Review ${fix.fromDisplayName} — ${fix.payee} may belong in ${fix.toLabel} (possible mismatch)`,
        );
      }
    }
  }

  if (contaminationReport.sections.some((s) => /\bbills\b/i.test(s.categoryName))) {
    medPri.push('Review Bills — credit card payments may be transfers, not bills');
  }
  if (
    contaminationReport.sections.some(
      (s) => /auto|gas/i.test(s.categoryName) && s.mismatches.some((m) => /atm/i.test(m.payee)),
    )
  ) {
    medPri.push('Review ATM Withdrawals in Auto & Gas — likely not fuel');
  }

  const emptyThin = thinList.filter((t) => t.count === 0);
  if (emptyThin.length > 0) {
    const names = emptyThin.map((t) => t.displayName).join(', ');
    lowPri.push(
      `Delete empty categories: ${names} — all have 0 transactions in loaded history; recently emptied by consolidation — safe to delete`,
    );
  }
  for (const t of thinList) {
    if (t.count > 0 && t.suggest.startsWith('merge')) {
      lowPri.push(`Thin category ${t.name} (${t.count} tx) — ${t.suggest}`);
    }
  }

  const reviewPayees = payeeConsistencyRows.filter((r) => r.tag === 'REVIEW');
  for (const row of reviewPayees.slice(0, 5)) {
    lowPri.push(`Review ${row.payee} split — ${row.parts} may be intentional`);
  }

  const dedupe = (/** @type {string[]} */ arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  };

  const highU = dedupe(highPri).sort((a, b) => b.length - a.length);
  const medU = dedupe(medPri);
  const lowU = dedupe(lowPri);

  console.log('');
  console.log('Recommended Actions');
  console.log('====================');
  let n = 1;
  if (highU.length) {
    console.log('\nHIGH PRIORITY (most transactions affected):');
    for (const line of highU) {
      console.log(`  ${n}. ${line}`);
      n++;
    }
    console.log(
      '     Tip: npm run consolidate-fix or npm run fix-auto (same as --fix --auto) applies fixes.',
    );
  }
  if (medU.length) {
    console.log('\nMEDIUM PRIORITY:');
    for (const line of medU) {
      console.log(`  ${n}. ${line}`);
      n++;
    }
  }
  if (lowU.length) {
    console.log('\nLOW PRIORITY (thin categories & optional reviews):');
    for (const line of lowU) {
      console.log(`  ${n}. ${line}`);
      n++;
    }
  }
  if (!highU.length && !medU.length && !lowU.length) {
    console.log('\n  (no automated suggestions)');
  }

  console.log('');
  console.log(
    `Heuristic redundant pairs: ${redundant.length}. Run npm run consolidate-fix or npm run fix-auto to apply (with prompts / --auto).`,
  );
}

/**
 * Remap transactions in one category whose payee label exactly matches (normalized).
 *
 * @param {string} fromCategoryId
 * @param {string} toCategoryId
 * @param {string} payeeLabel
 * @param {{ dryRun?: boolean, accounts?: object[], payeeById?: Map<string,string> }} [options]
 * @returns {Promise<{ remapped: number, errors: number }>}
 */
export async function remapTransactionsPayeeEquals(fromCategoryId, toCategoryId, payeeLabel, options = {}) {
  const dryRun = options.dryRun ?? false;
  let accounts = options.accounts;
  if (!accounts) {
    accounts = await getAccounts();
  }
  const payeeById = options.payeeById ?? new Map();
  const want = normalizePayeeKey(payeeLabel);

  let remapped = 0;
  let errors = 0;

  for (const acc of accounts) {
    if (acc.closed) continue;
    try {
      const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
      for (const t of txs) {
        if (t.category !== fromCategoryId) continue;
        const label = transactionPayeeLabel(t, payeeById);
        if (normalizePayeeKey(label) !== want) continue;
        try {
          if (!dryRun) {
            await applyCategory(t.id, toCategoryId);
          }
          remapped++;
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }
  }

  return { remapped, errors };
}

/**
 * @param {object} fix
 * @returns {string}
 */
function contaminationPrompt(fix) {
  if (fix.kind === 'BULK_RECATEGORIZE') {
    return `Fix ${fix.txCount} transactions in "${fix.fromDisplayName}" → ${fix.toName}? (Y/n) `;
  }
  return `Move "${fix.payee}" (${fix.txCount}x) from "${fix.fromDisplayName}" → ${fix.toName}? (Y/n) `;
}

/**
 * Apply contamination-driven fixes (bulk or per-payee subset).
 *
 * @param {object[]} fixPlan
 * @param {{ dryRun?: boolean, auto?: boolean, accounts?: object[], payeeById?: Map<string,string>, ask?: (q: string) => Promise<string> }} [options]
 * @returns {Promise<void>}
 */
export async function applyContaminationFixes(fixPlan, options = {}) {
  const dryRun = options.dryRun ?? config.DRY_RUN;
  const auto = options.auto ?? false;
  let accounts = options.accounts;
  if (!accounts) {
    accounts = await getAccounts();
  }
  const payeeById = options.payeeById ?? new Map();
  const ask = options.ask;

  for (const fix of fixPlan) {
    if (fix.confidence === 'LOW') continue;

    let proceed = false;
    if (auto && fix.confidence === 'HIGH') {
      proceed = true;
    } else if (ask) {
      const ans = await ask(contaminationPrompt(fix));
      if (fix.confidence === 'HIGH') {
        proceed = /^y(es)?$/i.test(ans.trim()) || ans.trim() === '';
      } else {
        proceed = /^y(es)?$/i.test(ans.trim());
      }
    }

    if (!proceed) {
      console.log(`→ Skipped contamination fix (${fix.confidence}): ${fix.kind} ${fix.fromDisplayName ?? fix.payee ?? ''}`);
      continue;
    }

    if (dryRun) {
      console.log(`→ [DRY RUN] Would apply ${fix.kind}: ${fix.fromDisplayName ?? fix.payee} → ${fix.toName}`);
      continue;
    }

    if (fix.kind === 'BULK_RECATEGORIZE') {
      const r = await remapTransactions(fix.fromCategoryId, fix.toCategoryId, { dryRun: false, accounts });
      console.log(`✓ Bulk recategorize: ${r.remapped} transactions → ${fix.toName}`);
    } else {
      const r = await remapTransactionsPayeeEquals(fix.fromCategoryId, fix.toCategoryId, fix.payee, {
        dryRun: false,
        accounts,
        payeeById,
      });
      console.log(`✓ Moved ${fix.payee}: ${r.remapped} transactions → ${fix.toName}`);
    }
  }
}

/**
 * Run redundant-pair remaps (respecting payee-based RECATEGORIZE) then optional contamination fixes.
 *
 * @param {Awaited<ReturnType<typeof gatherCategoryAuditData>>} audit
 * @param {{
 *   categories: object[],
 *   accounts: object[],
 *   payeeById: Map<string, string>,
 *   dryRun?: boolean,
 *   auto?: boolean,
 *   deleteAfter?: boolean,
 *   ask?: (q: string) => Promise<string>,
 *   skipRedundant?: boolean,
 *   skipContamination?: boolean,
 * }} options
 * @returns {Promise<{ redundantRemapped: number }>}
 */
export async function applyAuditRemediation(audit, options) {
  const dryRun = options.dryRun ?? config.DRY_RUN;
  const auto = options.auto ?? false;
  const accounts = options.accounts;
  const payeeById = options.payeeById;
  const deleteAfter = options.deleteAfter ?? false;
  const allowDelete =
    deleteAfter && config.AUTO_DELETE_EMPTY_CATEGORIES && !dryRun;
  let redundantRemapped = 0;

  if (!options.skipRedundant) {
    for (const r of audit.redundant) {
      const pinf = r.payeeInference;
      if (pinf?.recommendation === 'REVIEW' || pinf?.recommendation === 'KEEP SEPARATE') {
        continue;
      }

      let targetId = r.keepId;
      let targetName = r.suggestedKeep;

      if (pinf?.recommendation === 'RECATEGORIZE') {
        if (!pinf.targetCategoryId) {
          console.error(
            `✗ Skip "${r.suggestedRemove}": recategorize to "${pinf?.dominantLabel}" but no matching category in budget`,
          );
          continue;
        }
        targetId = pinf.targetCategoryId;
        targetName = pinf.targetCategoryName ?? pinf.dominantLabel ?? '?';
      }

      const { remapped, errors } = await remapTransactions(r.removeId, targetId, { dryRun, accounts });
      redundantRemapped += remapped;
      console.log(`Remapped ${remapped} transactions from [${r.suggestedRemove}] → [${targetName}]`);
      if (errors > 0) {
        console.error(`✗ ${errors} error(s) during remap [${r.suggestedRemove}] → [${targetName}]`);
      }
      if (allowDelete) {
        await deleteEmptyCategory(r.removeId, { dryRun, accounts });
      }
    }
  }

  if (!options.skipContamination && audit.contaminationFixPlan?.length) {
    console.log('\n--- Contamination fixes ---\n');
    await applyContaminationFixes(audit.contaminationFixPlan, {
      dryRun,
      auto,
      accounts,
      payeeById,
      ask: options.ask,
    });
  }

  return { redundantRemapped };
}

/**
 * Move all transactions from one category to another.
 * @param {string} fromCategoryId
 * @param {string} toCategoryId
 * @param {{ dryRun?: boolean, accounts?: object[] }} [options]
 * @returns {Promise<{ remapped: number, errors: number }>}
 */
export async function remapTransactions(fromCategoryId, toCategoryId, options = {}) {
  const dryRun = options.dryRun ?? false;
  let accounts = options.accounts;
  if (!accounts) {
    accounts = await getAccounts();
  }

  let remapped = 0;
  let errors = 0;

  for (const acc of accounts) {
    if (acc.closed) continue;
    try {
      const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
      for (const t of txs) {
        if (t.category !== fromCategoryId) continue;
        try {
          if (!dryRun) {
            await applyCategory(t.id, toCategoryId);
          }
          remapped++;
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }
  }

  return { remapped, errors };
}

/**
 * Delete a category only when no transactions reference it.
 * @param {string} categoryId
 * @param {{ dryRun?: boolean, accounts?: object[] }} [options]
 * @returns {Promise<void>}
 */
export async function deleteEmptyCategory(categoryId, options = {}) {
  const dryRun = options.dryRun ?? false;
  let accounts = options.accounts;
  if (!accounts) {
    accounts = await getAccounts();
  }

  const counts = await countTransactionsByCategory(accounts);
  const n = counts.get(categoryId) || 0;

  if (n > 0) {
    console.error(
      `✗ deleteEmptyCategory: ${n} transaction(s) still use category ${categoryId}; skip delete.`,
    );
    return;
  }

  if (dryRun) {
    console.log(`→ [DRY RUN] Would delete empty category ${categoryId}`);
    return;
  }

  try {
    await deleteCategory(categoryId);
    console.log(`✓ Deleted empty category ${categoryId}`);
  } catch (e) {
    console.error(`✗ deleteEmptyCategory failed: ${e.message}`);
  }
}

/**
 * Remap transactions using Ollama suggestions (fallback to keep category).
 * @param {object} pair — entry from findRedundantCategories
 * @param {CatLite[]} categories
 * @param {object[]} accounts
 * @param {Map<string, string>} payeeById
 * @param {boolean} dryRun
 * @returns {Promise<number>} remapped count
 */
async function remapPairWithOllama(pair, categories, accounts, payeeById, dryRun) {
  let remapped = 0;

  for (const acc of accounts) {
    if (acc.closed) continue;
    const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
    for (const t of txs) {
      if (t.category !== pair.removeId) continue;
      const payee = transactionPayeeLabel(t, payeeById);
      let suggestion;
      try {
        suggestion = await getCategorySuggestionFromModel(t, categories, payee, {});
      } catch {
        suggestion = pair.suggestedKeep;
      }
      let target = findCatByName(categories, suggestion);
      if (!target) {
        target = findCatByName(categories, pair.suggestedKeep);
      }
      if (!target) continue;
      if (target.id === pair.removeId) continue;
      try {
        if (!dryRun) {
          await applyCategory(t.id, target.id);
        }
        remapped++;
      } catch {
        // skip
      }
    }
  }

  return remapped;
}

/**
 * Merge redundant categories using manual map, heuristics, and/or Ollama.
 * @param {{
 *   dryRun?: boolean,
 *   useOllama?: boolean,
 *   manualMap?: Record<string, string>,
 *   deleteAfter?: boolean,
 * }} [options]
 * @returns {Promise<{ pairsProcessed: number, totalRemapped: number }>}
 */
export async function consolidateCategories(options = {}) {
  const dryRun = options.dryRun ?? config.DRY_RUN;
  const useOllama = options.useOllama ?? false;
  const manualMap = options.manualMap ?? {};
  const deleteAfter = options.deleteAfter ?? false;
  const allowDelete =
    deleteAfter && config.AUTO_DELETE_EMPTY_CATEGORIES && !dryRun;
  let totalRemapped = 0;

  const rawCats = await getCategories();
  /** @type {CatLite[]} */
  const categories = rawCats.map((c) => ({ id: c.id, name: c.name }));
  const accounts = await getAccounts();
  const payees = await getPayees();
  const payeeById = new Map(payees.map((p) => [p.id, p.name]));

  if (useOllama) {
    await assertOllamaReachable();
    loadMemory();
  }

  /** @type {{ removeId: string, keepId: string, removeName: string, keepName: string }[]} */
  const tasks = [];

  if (!useOllama && Object.keys(manualMap).length > 0) {
    for (const [fromName, toName] of Object.entries(manualMap)) {
      const fromC = findCatByName(categories, fromName);
      const toC = findCatByName(categories, toName);
      if (!fromC || !toC) {
        console.error(`✗ Manual map skip: "${fromName}" → "${toName}" (missing category)`);
        continue;
      }
      tasks.push({
        removeId: fromC.id,
        keepId: toC.id,
        removeName: fromC.name,
        keepName: toC.name,
      });
    }
  } else if (!useOllama) {
    const { byCategory } = await loadTransactionsGrouped(accounts, payeeById);
    const metricsById = new Map();
    for (const c of rawCats) {
      metricsById.set(
        c.id,
        buildCategoryMetrics(c, byCategory.get(c.id) ?? { txs: [], payeeCount: new Map() }),
      );
    }
    const redundant = await findRedundantCategories(categories, metricsById);
    for (const r of redundant) {
      const pinf = r.payeeInference;
      if (pinf?.recommendation === 'REVIEW' || pinf?.recommendation === 'KEEP SEPARATE') {
        console.log(
          `→ Skip redundant pair "${r.suggestedRemove}" vs "${r.suggestedKeep}" (${pinf?.recommendation ?? 'REVIEW'})`,
        );
        continue;
      }

      let targetId = r.keepId;
      let targetName = r.suggestedKeep;

      if (pinf?.recommendation === 'RECATEGORIZE') {
        if (!pinf.targetCategoryId) {
          console.error(
            `✗ Skip "${r.suggestedRemove}": recategorize to "${pinf?.dominantLabel}" but no matching category in budget`,
          );
          continue;
        }
        targetId = pinf.targetCategoryId;
        targetName = pinf.targetCategoryName ?? pinf.dominantLabel ?? '?';
      }

      tasks.push({
        removeId: r.removeId,
        keepId: targetId,
        removeName: r.suggestedRemove,
        keepName: targetName,
      });
    }
  } else {
    const redundant = await findRedundantCategories(categories);
    for (const r of redundant) {
      const n = await remapPairWithOllama(r, categories, accounts, payeeById, dryRun);
      totalRemapped += n;
      console.log(
        `Remapped ${n} transactions from [${r.suggestedRemove}] toward suggested targets (Ollama).`,
      );
      if (allowDelete) {
        await deleteEmptyCategory(r.removeId, { dryRun, accounts });
      }
    }
    return { pairsProcessed: redundant.length, totalRemapped };
  }

  for (const t of tasks) {
    const { remapped, errors } = await remapTransactions(t.removeId, t.keepId, {
      dryRun,
      accounts,
    });
    totalRemapped += remapped;
    console.log(`Remapped ${remapped} transactions from [${t.removeName}] to [${t.keepName}]`);
    if (errors > 0) {
      console.error(`✗ ${errors} error(s) during remap [${t.removeName}] → [${t.keepName}]`);
    }
    if (allowDelete) {
      await deleteEmptyCategory(t.removeId, { dryRun, accounts });
    }
  }

  return { pairsProcessed: tasks.length, totalRemapped };
}
