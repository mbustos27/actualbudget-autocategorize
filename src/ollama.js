import { config } from './config.js';
import { getTopExamples, loadMemory, lookupMerchant } from './memory.js';

const FEW_SHOT = `Here are example payee → category assignments:
- Whole Foods Market → Groceries
- Chevron → Auto & Gas
- City Water Dept → Utilities`;

const COMMON_MISTAKES = `Common mistakes to avoid:
- ATM withdrawal, ATM fee, cash withdrawal = Cash, never Utilities or Savings
- Any payee containing 'ATM' = Cash
- Jack in the Box, McDonald's, Burger King, Wendy's, Taco Bell, Chick-fil-A = Dining Out, never Groceries
- Walmart, Target, Costco, Sam's Club = could be Groceries OR Shopping depending on context, default to Groceries
- Amazon = Shopping unless it looks like a subscription, then Entertainment
- Netflix, Spotify, Hulu, Disney+, YouTube = Entertainment
- Shell, Chevron, Arco, 76, BP, Exxon = Gas, never Groceries
- ARCO, Circle K, 7-Eleven = Gas or Shopping, never Groceries
- Any payee with 'insurance' in the name = Insurance
- Any payee with 'mortgage' or 'rent' in the name = Housing`;

const REPLY_FOOTER = `Reply with ONLY the single category name that best fits.
Do not explain. Do not add punctuation. One line only.
Fast food restaurants are ALWAYS Dining Out, never Groceries.`;

/**
 * Actual Budget stores amounts as integer minor units (e.g. USD: cents, dollars × 100).
 */
export function amountToDollarString(amount) {
  if (amount == null || Number.isNaN(amount)) return '$0.00';
  const dollars = amount / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(dollars);
}

function findCategoryByName(categories, name) {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  return categories.find((c) => c.name.toLowerCase() === target) ?? null;
}

function findFallbackCategory(categories) {
  const prefer = ['uncategorized', 'other'];
  for (const p of prefer) {
    const found = categories.find((c) => c.name.toLowerCase() === p);
    if (found) return found;
  }
  return categories[0] ?? null;
}

/** Broad buckets we refuse as a final answer in refine mode (subset of REFINE_FROM_CATEGORY_NAMES). */
function isBroadCategoryName(name) {
  const n = String(name).trim().toLowerCase();
  if (!n) return false;
  return config.REFINE_FROM_CATEGORY_NAMES.some((b) => b === n);
}

function buildPrompt(
  transaction,
  categories,
  payeeLabel,
  retryHint,
  refine,
  currentCategoryName,
  memoryStrongHint,
  memoryExamplesSection,
) {
  const names = categories.map((c) => c.name).filter(Boolean);
  const categoryList = names.map((n) => `- ${n}`).join('\n');

  const autoCreate = config.AUTO_CREATE_CATEGORIES;

  let rules;
  if (refine) {
    rules = [
      'REFINE PASS: This transaction was filed under a broad category and should move to something MORE SPECIFIC.',
      `Current (broad) category: "${currentCategoryName || '(unknown)'}".`,
      'Pick the best-fitting SPECIFIC category from the list below.',
      'Do NOT reply with the same broad bucket names unless no other option exists (e.g. still truly uncategorizable).',
      autoCreate
        ? 'If nothing in the list fits, propose ONE new specific category name (not a vague label like General).'
        : 'You must choose an existing category name from the list.',
      REPLY_FOOTER,
    ];
  } else if (autoCreate) {
    rules = [
      'You classify each transaction into ONE budget category.',
      'Prefer an exact category name from the list below when it fits.',
      'If none fit well, reply with ONE new short category name you would create (plain words, 2–40 characters, no punctuation except & or /).',
      REPLY_FOOTER,
    ];
  } else {
    rules = [
      'You classify bank transactions into exactly one budget category from the list below.',
      'The name must exactly match one entry in the list above (same spelling; capitalization may differ).',
      REPLY_FOOTER,
    ];
  }

  if (memoryExamplesSection) {
    let insertIdx = rules.findIndex((r) => /reply with/i.test(r));
    if (insertIdx < 0) insertIdx = Math.max(0, rules.length - 1);
    rules.splice(insertIdx, 0, memoryExamplesSection);
  }

  const parts = [];
  if (memoryStrongHint) {
    parts.push(memoryStrongHint, '');
  }
  parts.push(
    ...rules,
    '',
    'Categories in this budget:',
    categoryList,
    '',
    FEW_SHOT,
    '',
    COMMON_MISTAKES,
    '',
    'Transaction to categorize:',
    `- Payee: ${payeeLabel}`,
    `- Amount: ${amountToDollarString(transaction.amount)} (negative = outflow / expense, positive = inflow)`,
    `- Date: ${transaction.date ?? '(unknown)'}`,
  );

  if (retryHint) {
    parts.push('', retryHint);
  }

  return parts.join('\n');
}

function extractCategoryNameFromResponse(text) {
  if (text == null) return '';
  const line = String(text).trim().split(/\r?\n/)[0];
  return line.replace(/^["']|["']$/g, '').trim();
}

export async function assertOllamaReachable() {
  const url = `${config.OLLAMA_URL}/api/tags`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    throw new Error(
      `Ollama does not appear to be reachable at ${config.OLLAMA_URL}. Is Ollama running? Try: ollama serve (${e.message})`,
    );
  }
}

/**
 * @param {object} options
 * @param {boolean} [options.refine]
 * @param {string} [options.currentCategoryName] — current broad category (refine pass)
 */
export async function getCategorySuggestionFromModel(
  transaction,
  categories,
  payeeLabel = '',
  options = {},
) {
  const { refine = false, currentCategoryName = '' } = options;

  const label =
    payeeLabel ||
    transaction.imported_payee ||
    transaction.payee_name ||
    '(no payee)';

  const maxAttempts = 3;
  let lastMismatch = false;
  const autoCreate = config.AUTO_CREATE_CATEGORIES;

  const allMemory = loadMemory();
  const memEntry = lookupMerchant(label);
  let memoryStrongHint = '';
  if (memEntry && memEntry.count >= 2) {
    memoryStrongHint = `Note: You have categorized ${label} as ${memEntry.category} ${memEntry.count} times before.\nStrongly prefer this category unless the transaction details suggest otherwise.`;
  }
  const topExamples = getTopExamples(label, allMemory, 3);
  let memoryExamplesSection = '';
  if (topExamples.length > 0) {
    memoryExamplesSection =
      'Past categorization examples from this user:\n' +
      topExamples.map((e) => `- ${e.payee} → ${e.category}`).join('\n');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let retryHint = '';
    if (attempt > 0 && lastMismatch) {
      if (refine) {
        retryHint =
          'Pick a more specific category than the broad bucket. Reply with one line: an existing specific name or one new specific category name.';
      } else if (autoCreate) {
        retryHint =
          'Your last reply was empty or unclear. Reply with one existing category name from the list OR one proposed new category name.';
      } else {
        retryHint =
          'Your last answer did not match any category name from the list. Reply again with exactly one category name from the allowed list.';
      }
    }

    const prompt = buildPrompt(
      transaction,
      categories,
      label,
      retryHint,
      refine,
      currentCategoryName,
      memoryStrongHint,
      memoryExamplesSection,
    );

    let responseText;
    try {
      const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          prompt,
          stream: false,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      responseText = data.response ?? data.text ?? '';
    } catch (e) {
      if (e.message?.includes('fetch')) {
        throw new Error(
          `Ollama request failed. Is Ollama running? Try: ollama serve (${e.message})`,
        );
      }
      throw e;
    }

    const pickedName = extractCategoryNameFromResponse(responseText);
    if (!pickedName) {
      lastMismatch = true;
      continue;
    }

    if (refine && isBroadCategoryName(pickedName)) {
      lastMismatch = true;
      continue;
    }

    const matched = findCategoryByName(categories, pickedName);
    if (matched) {
      if (refine && isBroadCategoryName(matched.name)) {
        lastMismatch = true;
        continue;
      }
      return matched.name;
    }

    if (autoCreate) {
      return pickedName;
    }

    lastMismatch = true;
  }

  if (refine && currentCategoryName) {
    return currentCategoryName;
  }

  const fb = findFallbackCategory(categories);
  return fb?.name ?? 'Uncategorized';
}
