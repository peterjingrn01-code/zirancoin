# ZiranCoin → JULE Store Coin API

This package creates a protected API endpoint:

POST https://zirancoin.jsl-ian.com/api/issue-coin

It issues one ZiranCoin credit after a verified JULE purchase.

## Files

- worker/worker.js
- worker/schema.sql
- wrangler.toml
- JULE-STORE-CONNECTION.txt
- TEST-COMMAND.txt

## Deployment

1. Create or open the Cloudflare Worker for the ZiranCoin API.
2. Upload `worker/worker.js`.
3. Bind the ZiranCoin D1 database as `DB`.
4. Run `worker/schema.sql` once in that D1 database.
5. Add Worker secret `COIN_API_KEY` with this value:

xZcTOmTFtfabyX1TbVuk-UCAqTqi_EHsz_utcic7cAI

6. Add the route:

zirancoin.jsl-ian.com/api/*

7. In the JULE Store Worker, add:

COIN_API_URL = https://zirancoin.jsl-ian.com/api/issue-coin

COIN_API_KEY = xZcTOmTFtfabyX1TbVuk-UCAqTqi_EHsz_utcic7cAI

## Safety

- The key is stored only as a Cloudflare Worker secret.
- The Stripe Checkout session ID is used as an idempotent reference.
- The same purchase cannot issue the coin twice.
- This uses dedicated tables and does not overwrite existing ZiranCoin tables.
