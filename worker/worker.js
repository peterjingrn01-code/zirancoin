const SUPPLY = 1000000000n;
const SCALE = 100000000n;
const OTP_TTL = 600;
const OTP_COOLDOWN = 60;
const MAX_ATTEMPTS = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      let body;

      if (url.pathname === "/api/health" && request.method === "GET") {
        body = {
          ok: true,
          service: "ziranz-api",
          auth: "resend-only",
          store_issue: true
        };
      } else if (url.pathname === "/api/auth/send-code" && request.method === "POST") {
        body = await sendCode(request, env);
      } else if (url.pathname === "/api/auth/verify-code" && request.method === "POST") {
        body = await verifyCode(request, env);
      } else if (url.pathname === "/api/me" && request.method === "GET") {
        body = await me(request, env);
      } else if (url.pathname === "/api/transfer" && request.method === "POST") {
        body = await transfer(request, env);
      } else if (url.pathname === "/api/explorer" && request.method === "GET") {
        body = await explorer(env);
      } else if (url.pathname === "/api/admin/genesis" && request.method === "POST") {
        body = await genesis(request, env);
      } else if (url.pathname === "/api/issue-coin" && request.method === "POST") {
        body = await issueStoreCoin(request, env);
      } else {
        return reply({ error: "Not found" }, 404, cors);
      }

      return reply(body, 200, cors);
    } catch (error) {
      console.error(error);
      return reply(
        { error: error.message || "Request failed" },
        error.status || 400,
        cors
      );
    }
  }
};

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function emailOf(value) {
  return String(value || "").trim().toLowerCase();
}

function clean(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function randomHex(bytes = 24) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map(x => x.toString(16).padStart(2, "0")).join("");
}

function code6() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1000000).padStart(6, "0");
}

async function sha256(value) {
  return [...new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    )
  )].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function otpHash(email, code, env) {
  if (!env.OTP_SECRET) fail("OTP_SECRET is not configured.", 500);
  return sha256(`${email}|${code}|${env.OTP_SECRET}`);
}

async function sendCode(request, env) {
  if (!env.RESEND_API_KEY) fail("RESEND_API_KEY is not configured.", 500);
  if (!env.RESEND_FROM_EMAIL) fail("RESEND_FROM_EMAIL is not configured.", 500);

  const data = await request.json();
  const email = emailOf(data.email);
  const intent = data.intent === "signin" ? "signin" : "signup";
  const name = clean(data.name, 80);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("Valid email required.");
  }

  const user = await env.SQL_DB
    .prepare("SELECT id,name FROM users WHERE email=?")
    .bind(email)
    .first();

  if (intent === "signup") {
    if (user) fail("This email already has an account.", 409);
    if (!name.length < 2) fail("Name is required.");
  } else if (!user) {
    fail("No account found for this email.", 404);
  }

  if (await env.DB.get(`otp-cooldown:${email}`)) {
    fail("Please wait one minute before requesting another code.", 429);
  }

  const code = code6();
  const createdAt = new Date().toISOString();

  await env.DB.put(
    `otp:${email}`,
    JSON.stringify({
      hash: await otpHash(email, code, env),
      intent,
      name: intent === "signup" ? name : user.name,
      attempts: 0
    }),
    { expirationTtl: OTP_TTL }
  );

  await env.DB.put(`otp-cooldown:${email}`, "1", {
    expirationTtl: OTP_COOLDOWN
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `ziran2-${email}-${createdAt}`
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Your Ziran2 verification code",
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Ziran2 Verification</h2>
        <p>Your one-time code is:</p>
        <p style="font-size:34px;font-weight:700;letter-spacing:8px">${code}</p>
        <p>This code expires in 10 minutes and can be used once.</p>
      </div>`
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    await env.DB.delete(`otp:${email}`);
    fail(result.message || result.error || "Resend failed to send the email.", response.status);
  }

  return { ok: true, message: "Verification code sent.", expires_in: OTP_TTL };
}

async function verifyCode(request, env) {
  const data = await request.json();
  const email = emailOf(data.email);
  const code = String(data.code || "").trim();

  if (!/^\d{6}$/.test(code)) fail("Enter the six-digit code.");

  const key = `otp:${email}`;
  const raw = await env.DB.get(key);
  if (!raw) fail("Code expired or was not requested.", 410);

  const record = JSON.parse(raw);

  if (record.attempts >= MAX_ATTEMPTS) {
    await env.DB.delete(key);
    fail("Too many attempts. Request a new code.", 429);
  }

  if (await otpHash(email, code, env) !== record.hash) {
    record.attempts += 1;
    await env.DB.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL });
    fail("Incorrect verification code.", 401);
  }

  let user = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE email=?")
    .bind(email)
    .first();

  if (record.intent === "signup") {
    if (user) {
      await env.DB.delete(key);
      fail("Account already exists.", 409);
    }

    const publicId = `ZR-${randomHex(8).toUpperCase()}`;
    const pairId = `PAIR-${randomHex(16).toUpperCase()}`;

    const inserted = await env.SQL_DB
      .prepare("INSERT INTO users(public_id,pair_id,name,email) VALUES(?,?,?,?)")
      .bind(publicId, pairId, record.name, email)
      .run();

    await env.SQL_DB
      .prepare("INSERT INTO wallets(user_id,balance) VALUES(?,?)")
      .bind(inserted.meta.last_row_id, "0")
      .run();

    user = await env.SQL_DB
      .prepare("SELECT * FROM users WHERE id=?")
      .bind(inserted.meta.last_row_id)
      .first();
  } else if (!user) {
    await env.DB.delete(key);
    fail("Account no longer exists.", 404);
  }

  await env.DB.delete(key);

  if (user.pair_status === "ACTIVE") {
    fail("Account Pair is locked.", 403);
  }

  const token = randomHex(32);
  await env.DB.put(`session:${token}`, String(user.id), {
    expirationTtl: 604800
  });

  return {
    ok: true,
    token,
    user: {
      name: user.name,
      email: user.email,
      public_id: user.public_id
    }
  };
}

async function auth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) fail("Unauthorized", 401);

  const id = await env.DB.get(`session:${header.slice(7)}`);
  if (!id) fail("Unauthorized", 401);

  const user = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE id=?")
    .bind(id)
    .first();

  if (!user) fail("Unauthorized", 401);
  return user;
}

function amountUnits(value) {
  const string = String(value).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(string)) fail("Invalid amount.");

  const [whole, fraction = ""] = string.split(".");
  const units = BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));

  if (units <= 0n) fail("Amount must be greater than zero.");
  return units;
}

function amountUnits0(value) {
  const [whole, fraction = ""] = String(value || "0").split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));
}

function amountText(units) {
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

async function me(request, env) {
  const user = await auth(request, env);

  const wallet = await env.SQL_DB
    .prepare("SELECT balance FROM wallets WHERE user_id=?")
    .bind(user.id)
    .first();

  const genesis = await env.SQL_DB
    .prepare("SELECT total_supply FROM genesis WHERE id=1")
    .first();

  const ledger = await env.SQL_DB
    .prepare(
      `SELECT l.*, cp.email counterparty_email
         FROM ledger l
         LEFT JOIN users cp ON cp.id=l.counterparty_user_id
        WHERE l.user_id=?
        ORDER BY l.id DESC
        LIMIT 100`
    )
    .bind(user.id)
    .all();

  return {
    user: {
      name: user.name,
      email: user.email,
      public_id: user.public_id,
      pair_status: user.pair_status
    },
    wallet: { balance: wallet?.balance || "0" },
    supply: genesis?.total_supply || "0",
    ledger: ledger.results
  };
}

async function transfer(request, env) {
  const from = await auth(request, env);
  const data = await request.json();

  const toEmail = emailOf(data.to_email);
  if (toEmail === from.email) fail("Cannot send to the same account.");

  const to = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE email=?")
    .bind(toEmail)
    .first();

  if (!to) fail("Recipient not found.", 404);

  const amount = amountUnits(data.amount);
  const amountString = amountText(amount);

  const fromWallet = await env.SQL_DB
    .prepare("SELECT balance FROM wallets WHERE user_id=?")
    .bind(from.id)
    .first();

  const toWallet = await env.SQL_DB
    .prepare("SELECT balance FROM wallets WHERE user_id=?")
    .bind(to.id)
    .first();

  const fromBalance = amountUnits0(fromWallet.balance);
  const toBalance = amountUnits0(toWallet.balance);

  if (fromBalance < amount) fail("Insufficient balance.");

  const txId = `TX-${randomHex(20).toUpperCase()}`;
  const proof = await sha256(
    [txId, from.pair_id, to.pair_id, amountString, new Date().toISOString()].join("|")
  );

  const newFrom = fromBalance - amount;
  const newTo = toBalance + amount;

  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .bind(amountText(newFrom), from.id),

    env.SQL_DB
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .bind(amountText(newTo), to.id),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,from_user_id,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?,?)"
      )
      .bind(txId, "TRANSFER", from.id, to.id, amountString, clean(data.memo, 160), proof),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(txId, from.id, to.id, "DEBIT", amountString, amountText(newFrom)),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(txId, to.id, from.id, "CREDIT", amountString, amountText(newTo))
  ]);

  return { ok: true, tx_id: txId, pair_proof: proof };
}

async function genesis(request, env) {
  const data = await request.json();

  if (!env.GENESIS_KEY) fail("GENESIS_KEY is not configured.", 500);
  if (String(data.genesis_key) !== env.GENESIS_KEY) fail("Invalid genesis key.", 403);

  const existing = await env.SQL_DB
    .prepare("SELECT id FROM genesis WHERE id=1")
    .first();

  if (existing) fail("Genesis already completed.", 409);

  const owner = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE email=?")
    .bind(emailOf(data.owner_email))
    .first();

  if (!owner) fail("Owner account must exist.", 404);

  const txId = `GENESIS-${randomHex(18).toUpperCase()}`;
  const amount = amountText(SUPPLY * SCALE);
  const proof = await sha256([txId, owner.pair_id, amount, "GENESIS"].join("|"));

  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare(
        "INSERT INTO genesis(id,tx_id,owner_user_id,total_supply,pair_proof) VALUES(1,?,?,?,?)"
      )
      .bind(txId, owner.id, amount, proof),

    env.SQL_DB
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .bind(amount, owner.id),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?)"
      )
      .bind(txId, "GENESIS", owner.id, amount, "Initial supply", proof),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?)"
      )
      .bind(txId, owner.id, "CREDIT", amount, amount)
  ]);

  return { ok: true, supply: amount, tx_id: txId, pair_proof: proof };
}

async function explorer(env) {
  const genesis = await env.SQL_DB
    .prepare("SELECT total_supply FROM genesis WHERE id=1")
    .first();

  const accounts = (await env.SQL_DB
    .prepare("SELECT COUNT(*) n FROM users")
    .first()).n;

  const transfers = (await env.SQL_DB
    .prepare("SELECT COUNT(*) n FROM transactions WHERE tx_type='TRANSFER'")
    .first()).n;

  const circulating = (await env.SQL_DB
    .prepare("SELECT COALESCE(SUM(CAST(balance AS REAL)),0) n FROM wallets")
    .first()).n;

  const latest = await env.SQL_DB
    .prepare(
      `SELECT t.tx_id,t.amount,t.pair_proof,t.created_at,
              fu.public_id from_public_id,
              tu.public_id to_public_id
         FROM transactions t
         LEFT JOIN users fu ON fu.id=t.from_user_id
         LEFT JOIN users tu ON tu.id=t.to_user_id
        ORDER BY t.id DESC
        LIMIT 25`
    )
    .all();

  return {
    supply: genesis?.total_supply || "0",
    circulating: String(circulating),
    accounts,
    transfers,
    latest: latest.results
  };
}

/*
 * JULE STORE → ZIRANCOIN
 * Protected endpoint:
 * POST /api/issue-coin
 *
 * Header:
 * Authorization: Bearer <COIN_API_KEY>
 *
 * Body:
 * {
 *   "email": "buyer@example.com",
 *   "amount": 1,
 *   "reason": "JULE Starter License",
 *   "reference": "cs_..."
 * }
 */
async function issueStoreCoin(request, env) {
  if (!env.COIN_API_KEY) fail("COIN_API_KEY is not configured.", 500);

  const authorization = request.headers.get("Authorization") || "";
  if (!secureEqual(authorization, `Bearer ${env.COIN_API_KEY}`)) {
    fail("Unauthorized.", 401);
  }

  const data = await request.json();
  const email = emailOf(data.email);
  const reason = clean(data.reason || "JULE Starter License", 160);
  const reference = clean(data.reference, 220);
  const amount = amountUnits(data.amount || "1");
  const amountString = amountText(amount);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("Valid customer email required.");
  }
  if (!reference) fail("Payment reference is required.");

  // Idempotency: the same Stripe Checkout session can issue only once.
  const issued = await env.SQL_DB
    .prepare("SELECT external_reference,status FROM jule_coin_ledger WHERE external_reference=?")
    .bind(reference)
    .first();

  if (issued) {
    const existingUser = await env.SQL_DB
      .prepare("SELECT id FROM users WHERE email=?")
      .bind(email)
      .first();

    const existingWallet = existingUser
      ? await env.SQL_DB.prepare("SELECT balance FROM wallets WHERE user_id=?")
          .bind(existingUser.id)
          .first()
      : null;

    return {
      ok: true,
      duplicate: true,
      status: issued.status,
      email,
      amount: amountString,
      balance: existingWallet?.balance || "0",
      reference
    };
  }

  // Create a normal ZiranCoin account automatically when the buyer is new.
  let recipient = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE email=?")
    .bind(email)
    .first();

  if (!recipient) {
    const publicId = `ZR-${randomHex(8).toUpperCase()}`;
    const pairId = `PAIR-${randomHex(16).toUpperCase()}`;
    const defaultName = email.split("@")[0].slice(0, 60) || "JULE Customer";

    const inserted = await env.SQL_DB
      .prepare("INSERT INTO users(public_id,pair_id,name,email) VALUES(?,?,?,?)")
      .bind(publicId, pairId, defaultName, email)
      .run();

    await env.SQL_DB
      .prepare("INSERT INTO wallets(user_id,balance) VALUES(?,?)")
      .bind(inserted.meta.last_row_id, "0")
      .run();

    recipient = await env.SQL_DB
      .prepare("SELECT * FROM users WHERE id=?")
      .bind(inserted.meta.last_row_id)
      .first();
  }

  // Debit the genesis owner so total supply never increases.
  const genesisRow = await env.SQL_DB
    .prepare("SELECT owner_user_id FROM genesis WHERE id=1")
    .first();

  if (!genesisRow) fail("Genesis has not been completed.", 409);
  if (Number(genesisRow.owner_user_id) === Number(recipient.id)) {
    fail("Store recipient cannot be the genesis owner.", 409);
  }

  const owner = await env.SQL_DB
    .prepare("SELECT * FROM users WHERE id=?")
    .bind(genesisRow.owner_user_id)
    .first();

  const ownerWallet = await env.SQL_DB
    .prepare("SELECT balance FROM wallets WHERE user_id=?")
    .bind(owner.id)
    .first();

  const recipientWallet = await env.SQL_DB
    .prepare("SELECT balance FROM wallets WHERE user_id=?")
    .bind(recipient.id)
    .first();

  const ownerBalance = amountUnits0(ownerWallet?.balance || "0");
  const recipientBalance = amountUnits0(recipientWallet?.balance || "0");

  if (ownerBalance < amount) fail("Genesis owner has insufficient balance.", 409);

  const nextOwnerBalance = ownerBalance - amount;
  const nextRecipientBalance = recipientBalance + amount;
  const txId = `STORE-${randomHex(18).toUpperCase()}`;
  const proof = await sha256(
    [txId, owner.pair_id, recipient.pair_id, amountString, reference].join("|")
  );

  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .bind(amountText(nextOwnerBalance), owner.id),

    env.SQL_DB
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .bind(amountText(nextRecipientBalance), recipient.id),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,from_user_id,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?,?)"
      )
      .bind(txId, "JULE_PURCHASE", owner.id, recipient.id, amountString, reason, proof),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(txId, owner.id, recipient.id, "DEBIT", amountString, amountText(nextOwnerBalance)),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(txId, recipient.id, owner.id, "CREDIT", amountString, amountText(nextRecipientBalance)),

    env.SQL_DB
      .prepare(
        `INSERT INTO jule_coin_ledger
         (email,amount,reason,external_reference,status,created_at)
         VALUES(?,?,?,?,?,unixepoch())`
      )
      .bind(email, Number(data.amount || 1), reason, reference, "issued")
  ]);

  return {
    ok: true,
    duplicate: false,
    status: "issued",
    coin: "ZiranCoin",
    email,
    amount: amountString,
    balance: amountText(nextRecipientBalance),
    tx_id: txId,
    pair_proof: proof,
    reference
  };
}

function secureEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
    }
