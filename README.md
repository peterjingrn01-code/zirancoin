# Ziran2 Pair Coin 1.0

## Included
- Responsive desktop/mobile website
- User sign-up and sign-in
- Salted PBKDF2-SHA256 password storage
- Internal unique Pair ID for every account
- Wallet and balanced ledger
- Send / receive
- Public Explorer
- One-time Genesis: exactly 1,000,000,000 ZIRAN
- KV sessions, seven-day expiry
- Cloudflare Worker API
- D1 schema
- No additional issuance endpoint

## Required Cloudflare resources
- D1: `ziran_db`
- KV: `ziran_db_kv`
- Binding: `SQL_DB` → `ziran_db`
- Binding: `DB` → `ziran_db_kv`
- Secret: `GENESIS_KEY`
- Variable: `ALLOWED_ORIGIN`

## Deployment order
1. Create the `ziran2` Worker project and connect this repository.
2. Create or reuse D1 database `ziran_db`.
3. Open D1 Console and run `worker/schema.sql`.
4. Create or reuse KV namespace `ziran_db_kv`.
5. Bind D1 with variable name `SQL_DB`.
6. Bind KV with variable name `DB`.
7. Add a long random secret named `GENESIS_KEY`.
8. Set `ALLOWED_ORIGIN` to the final Ziran2 website origin.
9. Deploy.
10. Open `/api/health`; expected result: `{"ok":true,"service":"ziran2-api"}`.
11. Create the owner account through `signup.html`.
12. Open `admin.html`; enter the owner email and the server-side `GENESIS_KEY`.
13. Execute genesis once.
14. Confirm owner balance: `1,000,000,000 ZIRAN`.
15. Create a second account and test a transfer.
16. Confirm both ledger entries and the Explorer transaction.

## Pair-proof status
The present proof is an engineering prototype using SHA-256 over the transaction ID,
sender Pair ID, receiver Pair ID, amount, and time. It is deliberately isolated so the
final Pair coding theory can replace it. It is not represented as a completed, formally
proven post-quantum cryptographic system.
