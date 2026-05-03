import * as api from '@actual-app/api';
import { connect, getAccounts, disconnect } from '../src/actual.js';

const search = (process.argv[2] ?? '').toLowerCase();
if (!search) {
  console.log('Usage: node scripts/find-payee.mjs <search term>');
  process.exit(1);
}

await connect();
const accounts = await getAccounts();
const found = [];

for (const acc of accounts) {
  const txs = await api.getTransactions(acc.id, '2000-01-01', '2099-12-31');
  for (const tx of txs) {
    const ip = String(tx.imported_payee ?? '').toLowerCase();
    const pn = String(tx.payee_name ?? '').toLowerCase();
    if (ip.includes(search) || pn.includes(search)) {
      found.push({
        account: acc.name,
        imported_payee: tx.imported_payee,
        payee_name: tx.payee_name,
        category: tx.category,
        amount: tx.amount,
        date: tx.date,
      });
    }
  }
}

await disconnect();

if (found.length === 0) {
  console.log('No transactions found matching: ' + search);
} else {
  console.log(`Found ${found.length} transactions matching "${search}":\n`);
  for (const t of found) {
    console.log('  Account:        ' + t.account);
    console.log('  imported_payee: ' + (t.imported_payee ?? '(empty)'));
    console.log('  payee_name:     ' + (t.payee_name ?? '(empty)'));
    console.log('  category:       ' + t.category);
    console.log('  amount:         $' + (Math.abs(t.amount) / 100).toFixed(2));
    console.log('  date:           ' + t.date);
    console.log('');
  }
}
