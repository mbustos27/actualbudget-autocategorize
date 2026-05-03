# actualbudget-autocategorize — Command Reference
# Last updated: 2026-05-03

## DAILY / ANYTIME
.\run-categorizer.ps1              # categorize new transactions (GPU-accelerated)
.\run-categorizer.ps1 -DryRun      # preview without saving

## WEEKLY
npm run analyze                    # full category health report
npm run tracker                    # mid-month budget vs actual

## SEARCH & DEBUG
node scripts/find-payee.mjs "name" # find transactions by payee name

## FIX CATEGORIZATION
node scripts/consolidate.mjs --fix --auto   # auto-fix high confidence issues
npm run fix-specific                         # apply hardcoded payee moves
npm run delete-empty                         # delete 0-transaction categories
npm run analyze                              # verify results

## BEGINNING OF EACH MONTH
# 1. Update account balances in .env:
#    ACCOUNT_BALANCE_CHASE_COLLEGE=
#    ACCOUNT_BALANCE_CHASE_SAVINGS=
#    ACCOUNT_BALANCE_CHASE_FREEDOM=
#    BALANCE_AS_OF_DATE=YYYY-MM-DD
#
# 2. Generate AI budget
npm run ideate:export
#
# 3. Apply off-season budget (May-Dec)
node scripts/apply-budget.mjs --month YYYY-MM --yes --overwrite --amounts "Bills=363,Auto & Gas=306,Utilities=97,Software=60,Dining Out=525,Shopping=726,Groceries=240,Entertainment=130,Hobbies=6,Savings=900"
#
# 4. Apply peak season budget (Jan-Apr)
node scripts/apply-budget.mjs --month YYYY-MM --yes --overwrite --amounts "Bills=365,Auto & Gas=305,Utilities=85,Software=55,Dining Out=725,Shopping=935,Groceries=220,Entertainment=125,Hobbies=5,Savings=3140"

## END OF EACH MONTH
npm run summary:last               # AI spending summary
npm run email-report               # send monthly email report
node scripts/compare-months.mjs YYYY-MM YYYY-MM   # compare two months

## SEASONAL RUNWAY CHECK
npm run ideate:export              # shows runway analysis at bottom

## AUTOMATION (run once as Administrator)
powershell -File scripts/setup-automation.ps1

## YOUR FINANCIAL SNAPSHOT (as of 2026-05-03)
# Checking:        ,275
# Savings:         ,600
# Credit card:     -
# Net worth:       ,596
#
# Off-season income:  ,794/month
# Monthly budget:     ,293/month
# Monthly surplus:    /month
# Savings target:     /month
# Projected year-end savings: ,800
