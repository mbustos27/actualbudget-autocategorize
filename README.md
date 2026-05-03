# actualbudget-autocategorize

Headless CLI tool that connects to [Actual Budget](https://actualbudget.org/) (for example on [PikaPods](https://www.pikapods.com/)) and assigns categories to uncategorized transactions using a local [Ollama](https://ollama.com/) model (default: **llama3**).

## Prerequisites

- **Node.js 20+**
- **Ollama** installed, with the model pulled: `ollama pull llama3`
- **Actual Budget** reachable at your server URL (e.g. PikaPods HTTPS URL)
- Sync ID and server password from Actual Budget

## Setup

1. Clone or copy this project and enter the directory:

   ```bash
   cd actualbudget-autocategorize
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy the environment template and edit `.env`:

   ```bash
   copy .env.example .env
   ```

   On macOS/Linux:

   ```bash
   cp .env.example .env
   ```

4. Fill in `.env`:

   - `ACTUAL_SERVER_URL` — your Actual server base URL (no trailing slash required).
   - `ACTUAL_PASSWORD` — login password for that server.
   - `ACTUAL_BUDGET_ID` — the budget **Sync ID** (see below).
   - `ACTUAL_DATA_DIR` — local folder for cached budget data (created if missing).
   - `OLLAMA_URL` — usually `http://localhost:11434`.
   - `OLLAMA_MODEL` — e.g. `llama3`.
   - `DRY_RUN` — set to `true` to preview categories without updating Actual.
   - `AUTO_CREATE_CATEGORIES` — when `true` (default), if the model suggests a name that is not already in your budget, the script **creates** that category (see placement below). Set to `false` to only use existing categories (falls back to Uncategorized/Other).
   - `ACTUAL_NEW_CATEGORY_GROUP_ID` — optional UUID of the **category group** where new **expense** categories should be created.
   - `ACTUAL_NEW_CATEGORY_GROUP_NAME` — optional: match a group by name (e.g. `Flexible`) if the ID is unset.
   - If neither is set, new **expense** categories use the first non-income group; positive amounts use the income group when creating income categories.

### Finding `ACTUAL_BUDGET_ID`

In Actual Budget: **Settings** → scroll to **Advanced** → copy **Sync ID** (UUID). That value is `ACTUAL_BUDGET_ID`.

## Running

Start Ollama (if it is not already running):

```bash
ollama serve
```

**Dry run** (no writes to Actual; shows what would be assigned):

```bash
npm run dry-run
```

**Apply categories** (writes to Actual):

```bash
npm start
```

You can also set `DRY_RUN=true` in `.env` and run `npm start`.

### Two-pass: initial categorize, then refine broad buckets

Some runs label many lines as a catch-all (e.g. **General**). A **second pass** re-runs the model on transactions *already* in those broad categories and asks for a **more specific** name (it will not accept the same broad bucket as an answer when possible).

- **`npm run double-run`** — pass 1: uncategorized only; pass 2: refine (no disconnect between). Reloads the category list between passes.
- **`npm run double-dry-run`** — same, dry run.

Refine **only** (e.g. after you have already run a first pass on another day):

- **`npm run refine`** — only transactions whose **current** category name matches **`REFINE_FROM_CATEGORY_NAMES`** (default: `General`).
- **`npm run refine-dry-run`**

Set broad bucket names in `.env` (comma-separated, case-insensitive):

```env
REFINE_FROM_CATEGORY_NAMES=General,Miscellaneous
```

Or set **`REFINE_MODE=true`** / **`DOUBLE_RUN=true`** in `.env` instead of using npm scripts.

## Amounts

Actual’s API stores transaction amounts as **integers in minor currency units** (for USD, typically **cents**: \( \text{dollars} \times 100 \)). This tool displays amounts in dollars using that convention. (If your currency uses different scaling, adjust your interpretation accordingly.)

## Automate with cron

Run daily at 7:00 with logs appended to a file (Linux/macOS example):

```cron
0 7 * * * cd /path/to/actualbudget-autocategorize && /usr/bin/npm start >> /var/log/actual-autocat.log 2>&1
```

On Windows, use **Task Scheduler** to run `npm start` in the project folder, or call `node src/index.js` with the same working directory and environment.

## Troubleshooting

| Issue | What to check |
| --- | --- |
| **Ollama unreachable** | Run `ollama serve`. Confirm `OLLAMA_URL` (default `http://localhost:11434`). Run `ollama pull llama3` if the model is missing. |
| **Wrong budget / empty data** | Verify `ACTUAL_BUDGET_ID` matches **Settings → Advanced → Sync ID**. |
| **Connection errors** | Confirm `ACTUAL_SERVER_URL` and `ACTUAL_PASSWORD`. The error message includes the URL in use. Check firewall and HTTPS certificates. |
| **Nothing to categorize** | Only transactions with **no category** are processed. Already categorized lines are skipped. |
| **`out-of-sync-migrations` / migration errors** | Run **`.\reset-cache-and-install.ps1`** (deletes `package-lock.json` + `actual-data`, then `npm install`), or do that manually. Confirm **`npm ls @actual-app/api`** shows **26.x**. Use **Node 20+**. |
