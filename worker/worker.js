const SUPPLY = 1000000000n;
const SCALE = 100000000n;

const OTP_TTL = 600;
const OTP_COOLDOWN = 60;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 604800;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {
      /*
       * Health check does not require the database bindings to be present,
       * so it can clearly report which configuration is missing.
       */
      if (
        url.pathname === "/api/health" &&
        request.method === "GET"
      ) {
        return reply(
          {
            ok: true,
            service: "zirancoin-api-production-1.0",
            d1: Boolean(env.SQL_DB),
            kv: Boolean(env.DB),
            assets: Boolean(env.ASSETS),
            resend: Boolean(
              env.RESEND_API_KEY &&
              env.RESEND_FROM_EMAIL &&
              env.OTP_SECRET
            ),
            store_issue: Boolean(env.COIN_API_KEY)
          },
          200,
          cors
        );
      }

      /*
       * All remaining API functions require D1 and KV.
       */
      if (url.pathname.startsWith("/api/")) {
        requireBinding(env.SQL_DB, "SQL_DB");
        requireBinding(env.DB, "DB");
      }

      if (
        url.pathname === "/api/auth/send-code" &&
        request.method === "POST"
      ) {
        return reply(
          await sendCode(request, env),
          200,
          cors
        );
      }

      if (
        url.pathname === "/api/auth/verify-code" &&
        request.method === "POST"
      ) {
        return reply(
          await verifyCode(request, env),
          200,
          cors
        );
      }

      if (
        url.pathname === "/api/me" &&
        request.method === "GET"
      ) {
        return reply(
          await me(request, env),
          200,
          cors
        );
      }

      if (
        (
          url.pathname === "/api/transfer" ||
          url.pathname === "/api/send"
        ) &&
        request.method === "POST"
      ) {
        return reply(
          await transfer(request, env),
          200,
          cors
        );
      }

      if (
        url.pathname === "/api/explorer" &&
        request.method === "GET"
      ) {
        return reply(
          await explorer(env),
          200,
          cors
        );
      }

      if (
        url.pathname === "/api/admin/genesis" &&
        request.method === "POST"
      ) {
        return reply(
          await genesis(request, env),
          200,
          cors
        );
      }

      /*
       * JULE Store protected Coin-credit endpoint.
       */
      if (
        url.pathname === "/api/issue-coin" &&
        request.method === "POST"
      ) {
        return reply(
          await issueStoreCoin(request, env),
          200,
          cors
        );
      }

      if (url.pathname.startsWith("/api/")) {
        return reply(
          {
            error: "API route not found.",
            path: url.pathname,
            method: request.method
          },
          404,
          cors
        );
      }

      /*
       * Preserve the independent ZiranCoin website.
       */
      if (
        env.ASSETS &&
        typeof env.ASSETS.fetch === "function"
      ) {
        return env.ASSETS.fetch(request);
      }

      return reply(
        {
          error: "Static assets binding is unavailable."
        },
        503,
        cors
      );
    } catch (error) {
      console.error("ZiranCoin API error:", {
        path: url.pathname,
        method: request.method,
        status: error?.status || 500,
        message: error?.message || String(error)
      });

      return reply(
        {
          error: error?.message || "Request failed."
        },
        error?.status || 500,
        cors
      );
    }
  }
};

/* =========================================================
   Basic response and validation helpers
   ========================================================= */

function reply(data, status = 200, extraHeaders = {}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    }
  );
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireBinding(binding, name) {
  if (!binding) {
    fail(`${name} binding is not configured.`, 500);
  }
}

function emailOf(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function clean(value, maximum = 160) {
  return String(value || "")
    .trim()
    .slice(0, maximum);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomHex(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function sixDigitCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);

  return String(values[0] % 1000000)
    .padStart(6, "0");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value))
  );

  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function secureEqual(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");

  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= (
      left.charCodeAt(index) ^
      right.charCodeAt(index)
    );
  }

  return difference === 0;
}

/* =========================================================
   Amount handling — maximum eight decimal places
   ========================================================= */

function amountUnits(value) {
  const text = String(value || "").trim();

  if (!/^\d+(\.\d{1,8})?$/.test(text)) {
    fail("Invalid amount.");
  }

  const [whole, fractional = ""] = text.split(".");

  const units =
    BigInt(whole) * SCALE +
    BigInt(
      (fractional + "00000000").slice(0, 8)
    );

  if (units <= 0n) {
    fail("Amount must be greater than zero.");
  }

  return units;
}

function amountUnitsZero(value) {
  const text = String(value || "0").trim();

  if (!/^\d+(\.\d{1,8})?$/.test(text)) {
    fail("Invalid stored wallet balance.", 500);
  }

  const [whole, fractional = ""] = text.split(".");

  return (
    BigInt(whole) * SCALE +
    BigInt(
      (fractional + "00000000").slice(0, 8)
    )
  );
}

function amountText(units) {
  const whole = units / SCALE;

  const fractional = (units % SCALE)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");

  return fractional
    ? `${whole}.${fractional}`
    : `${whole}`;
}

/* =========================================================
   OTP and account authentication
   ========================================================= */

async function otpHash(email, code, env) {
  if (!env.OTP_SECRET) {
    fail("OTP_SECRET is not configured.", 500);
  }

  return sha256(
    `${email}|${code}|${env.OTP_SECRET}`
  );
}

async function sendCode(request, env) {
  if (!env.RESEND_API_KEY) {
    fail("RESEND_API_KEY is not configured.", 500);
  }

  if (!env.RESEND_FROM_EMAIL) {
    fail("RESEND_FROM_EMAIL is not configured.", 500);
  }

  if (!env.OTP_SECRET) {
    fail("OTP_SECRET is not configured.", 500);
  }

  const data = await readJson(request);

  const email = emailOf(data.email);
  const name = clean(data.name, 80);
  const intent =
    data.intent === "signin"
      ? "signin"
      : "signup";

  if (!validEmail(email)) {
    fail("Valid email required.");
  }

  const user = await env.SQL_DB
    .prepare(
      "SELECT id,name,email FROM users WHERE email=?"
    )
    .bind(email)
    .first();

  if (intent === "signup") {
    if (user) {
      fail(
        "This email already has an account.",
        409
      );
    }

    if (name.length < 2) {
      fail("Name is required.");
    }
  } else if (!user) {
    fail(
      "No account found for this email.",
      404
    );
  }

  const cooldownKey =
    `otp-cooldown:${email}`;

  if (await env.DB.get(cooldownKey)) {
    fail(
      "Please wait one minute before requesting another code.",
      429
    );
  }

  const code = sixDigitCode();

  const record = {
    hash: await otpHash(email, code, env),
    intent,
    name:
      intent === "signup"
        ? name
        : user.name,
    attempts: 0
  };

  await env.DB.put(
    `otp:${email}`,
    JSON.stringify(record),
    {
      expirationTtl: OTP_TTL
    }
  );

  await env.DB.put(
    cooldownKey,
    "1",
    {
      expirationTtl: OTP_COOLDOWN
    }
  );

  const resendResponse = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${String(env.RESEND_API_KEY).trim()}`,
        "Content-Type": "application/json",
        "Idempotency-Key":
          `zirancoin-${email}-${Date.now()}`
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [email],
        subject:
          "Your ZiranCoin verification code",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
            <h2>ZiranCoin Verification</h2>
            <p>Your one-time verification code is:</p>
            <p style="font-size:34px;font-weight:700;letter-spacing:8px">
              ${code}
            </p>
            <p>This code expires in 10 minutes and can be used once.</p>
          </div>
        `
      })
    }
  );

  const responseText =
    await resendResponse.text();

  let resendResult = {};

  try {
    resendResult = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    resendResult = {};
  }

  if (!resendResponse.ok) {
    await env.DB.delete(`otp:${email}`);

    fail(
      resendResult.message ||
      resendResult.error ||
      "Resend failed to send the email.",
      resendResponse.status || 500
    );
  }

  return {
    ok: true,
    message: "Verification code sent.",
    expires_in: OTP_TTL
  };
}

async function verifyCode(request, env) {
  const data = await readJson(request);

  const email = emailOf(data.email);
  const code = String(data.code || "").trim();

  if (!validEmail(email)) {
    fail("Valid email required.");
  }

  if (!/^\d{6}$/.test(code)) {
    fail("Enter the six-digit code.");
  }

  const otpKey = `otp:${email}`;
  const stored = await env.DB.get(otpKey);

  if (!stored) {
    fail(
      "Code expired or was not requested.",
      410
    );
  }

  let record;

  try {
    record = JSON.parse(stored);
  } catch {
    await env.DB.delete(otpKey);
    fail("Verification record is invalid.", 500);
  }

  if (
    Number(record.attempts || 0) >=
    MAX_ATTEMPTS
  ) {
    await env.DB.delete(otpKey);

    fail(
      "Too many attempts. Request a new code.",
      429
    );
  }

  const submittedHash =
    await otpHash(email, code, env);

  if (
    !secureEqual(
      submittedHash,
      String(record.hash || "")
    )
  ) {
    record.attempts =
      Number(record.attempts || 0) + 1;

    await env.DB.put(
      otpKey,
      JSON.stringify(record),
      {
        expirationTtl: OTP_TTL
      }
    );

    fail(
      "Incorrect verification code.",
      401
    );
  }

  let user = await env.SQL_DB
    .prepare(
      "SELECT * FROM users WHERE email=?"
    )
    .bind(email)
    .first();

  if (record.intent === "signup") {
    if (user) {
      await env.DB.delete(otpKey);

      fail(
        "Account already exists.",
        409
      );
    }

    const publicId =
      `ZR-${randomHex(8).toUpperCase()}`;

    const pairId =
      `PAIR-${randomHex(16).toUpperCase()}`;

    const inserted = await env.SQL_DB
      .prepare(
        "INSERT INTO users(public_id,pair_id,name,email) VALUES(?,?,?,?)"
      )
      .bind(
        publicId,
        pairId,
        clean(record.name, 80),
        email
      )
      .run();

    const userId =
      inserted.meta.last_row_id;

    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(userId, "0")
      .run();

    user = await env.SQL_DB
      .prepare(
        "SELECT * FROM users WHERE id=?"
      )
      .bind(userId)
      .first();
  } else if (!user) {
    await env.DB.delete(otpKey);

    fail(
      "Account no longer exists.",
      404
    );
  }

  await env.DB.delete(otpKey);

  if (
    String(user.pair_status || "")
      .toUpperCase() === "LOCKED"
  ) {
    fail(
      "Account Pair is locked.",
      403
    );
  }

  const token = randomHex(32);

  await env.DB.put(
    `session:${token}`,
    String(user.id),
    {
      expirationTtl: SESSION_TTL
    }
  );

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

async function authenticate(request, env) {
  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    fail("Unauthorized.", 401);
  }

  const token =
    authorization.slice(7).trim();

  if (!token) {
    fail("Unauthorized.", 401);
  }

  const userId = await env.DB.get(
    `session:${token}`
  );

  if (!userId) {
    fail("Unauthorized.", 401);
  }

  const user = await env.SQL_DB
    .prepare(
      "SELECT * FROM users WHERE id=?"
    )
    .bind(userId)
    .first();

  if (!user) {
    fail("Unauthorized.", 401);
  }

  if (
    String(user.pair_status || "")
      .toUpperCase() === "LOCKED"
  ) {
    fail(
      "Account Pair is locked.",
      403
    );
  }

  return user;
}

/* =========================================================
   Independent ZiranCoin account dashboard
   ========================================================= */

async function me(request, env) {
  const user =
    await authenticate(request, env);

  let wallet = await env.SQL_DB
    .prepare(
      "SELECT balance FROM wallets WHERE user_id=?"
    )
    .bind(user.id)
    .first();

  /*
   * Repair an old account that exists without a wallet.
   */
  if (!wallet) {
    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(user.id, "0")
      .run();

    wallet = {
      balance: "0"
    };
  }

  const genesisRecord =
    await env.SQL_DB
      .prepare(
        "SELECT total_supply FROM genesis WHERE id=1"
      )
      .first();

  const ledgerResult =
    await env.SQL_DB
      .prepare(
        `
        SELECT
          l.id,
          l.tx_id,
          l.entry_type,
          l.amount,
          l.balance_after,
          l.created_at,
          cp.email AS counterparty_email,
          cp.public_id AS counterparty_public_id
        FROM ledger l
        LEFT JOIN users cp
          ON cp.id = l.counterparty_user_id
        WHERE l.user_id = ?
        ORDER BY l.id DESC
        LIMIT 100
        `
      )
      .bind(user.id)
      .all();

  return {
    ok: true,
    user: {
      name: user.name,
      email: user.email,
      public_id: user.public_id,
      pair_status: user.pair_status
    },
    wallet: {
      balance: wallet.balance || "0"
    },
    supply:
      genesisRecord?.total_supply || "0",
    ledger:
      ledgerResult.results || []
  };
}

/* =========================================================
   Independent user-to-user ZiranCoin transfer
   ========================================================= */

async function transfer(request, env) {
  const sender =
    await authenticate(request, env);

  const data = await readJson(request);

  const recipientEmail = emailOf(
    data.to_email ||
    data.email ||
    data.recipient_email
  );

  if (!validEmail(recipientEmail)) {
    fail("Valid recipient email required.");
  }

  if (recipientEmail === sender.email) {
    fail(
      "Cannot send to the same account."
    );
  }

  const recipient = await env.SQL_DB
    .prepare(
      "SELECT * FROM users WHERE email=?"
    )
    .bind(recipientEmail)
    .first();

  if (!recipient) {
    fail("Recipient not found.", 404);
  }

  const amount =
    amountUnits(data.amount);

  const amountString =
    amountText(amount);

  const senderWallet =
    await env.SQL_DB
      .prepare(
        "SELECT balance FROM wallets WHERE user_id=?"
      )
      .bind(sender.id)
      .first();

  let recipientWallet =
    await env.SQL_DB
      .prepare(
        "SELECT balance FROM wallets WHERE user_id=?"
      )
      .bind(recipient.id)
      .first();

  if (!senderWallet) {
    fail(
      "Sender wallet was not found.",
      409
    );
  }

  if (!recipientWallet) {
    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(recipient.id, "0")
      .run();

    recipientWallet = {
      balance: "0"
    };
  }

  const senderBalance =
    amountUnitsZero(senderWallet.balance);

  const recipientBalance =
    amountUnitsZero(recipientWallet.balance);

  if (senderBalance < amount) {
    fail("Insufficient balance.", 409);
  }

  const nextSenderBalance =
    senderBalance - amount;

  const nextRecipientBalance =
    recipientBalance + amount;

  const transactionId =
    `TX-${randomHex(20).toUpperCase()}`;

  const memo = clean(data.memo, 160);

  const proof = await sha256(
    [
      transactionId,
      sender.pair_id,
      recipient.pair_id,
      amountString,
      memo,
      new Date().toISOString()
    ].join("|")
  );

  /*
   * Your current D1 CHECK constraint permits:
   * GENESIS and TRANSFER.
   */
  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare(
        "UPDATE wallets SET balance=? WHERE user_id=?"
      )
      .bind(
        amountText(nextSenderBalance),
        sender.id
      ),

    env.SQL_DB
      .prepare(
        "UPDATE wallets SET balance=? WHERE user_id=?"
      )
      .bind(
        amountText(nextRecipientBalance),
        recipient.id
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,from_user_id,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        "TRANSFER",
        sender.id,
        recipient.id,
        amountString,
        memo,
        proof
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        sender.id,
        recipient.id,
        "DEBIT",
        amountString,
        amountText(nextSenderBalance)
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        recipient.id,
        sender.id,
        "CREDIT",
        amountString,
        amountText(nextRecipientBalance)
      )
  ]);

  return {
    ok: true,
    status: "sent",
    tx_id: transactionId,
    amount: amountString,
    balance: amountText(nextSenderBalance),
    recipient: {
      email: recipient.email,
      public_id: recipient.public_id
    },
    pair_proof: proof
  };
}

/* =========================================================
   Genesis — preserved but cannot run twice
   ========================================================= */

async function genesis(request, env) {
  if (!env.GENESIS_KEY) {
    fail(
      "GENESIS_KEY is not configured.",
      500
    );
  }

  const data = await readJson(request);

  if (
    !secureEqual(
      String(data.genesis_key || ""),
      String(env.GENESIS_KEY)
    )
  ) {
    fail("Invalid genesis key.", 403);
  }

  const existing = await env.SQL_DB
    .prepare(
      "SELECT id FROM genesis WHERE id=1"
    )
    .first();

  if (existing) {
    fail(
      "Genesis already completed.",
      409
    );
  }

  const ownerEmail =
    emailOf(data.owner_email);

  const owner = await env.SQL_DB
    .prepare(
      "SELECT * FROM users WHERE email=?"
    )
    .bind(ownerEmail)
    .first();

  if (!owner) {
    fail(
      "Owner account must exist.",
      404
    );
  }

  let ownerWallet = await env.SQL_DB
    .prepare(
      "SELECT balance FROM wallets WHERE user_id=?"
    )
    .bind(owner.id)
    .first();

  if (!ownerWallet) {
    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(owner.id, "0")
      .run();

    ownerWallet = {
      balance: "0"
    };
  }

  const transactionId =
    `GENESIS-${randomHex(18).toUpperCase()}`;

  const totalSupply =
    amountText(SUPPLY * SCALE);

  const proof = await sha256(
    [
      transactionId,
      owner.pair_id,
      totalSupply,
      "GENESIS"
    ].join("|")
  );

  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare(
        "INSERT INTO genesis(id,tx_id,owner_user_id,total_supply,pair_proof) VALUES(1,?,?,?,?)"
      )
      .bind(
        transactionId,
        owner.id,
        totalSupply,
        proof
      ),

    env.SQL_DB
      .prepare(
        "UPDATE wallets SET balance=? WHERE user_id=?"
      )
      .bind(
        totalSupply,
        owner.id
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        "GENESIS",
        owner.id,
        totalSupply,
        "Initial supply",
        proof
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?)"
      )
      .bind(
        transactionId,
        owner.id,
        "CREDIT",
        totalSupply,
        totalSupply
      )
  ]);

  return {
    ok: true,
    status: "completed",
    supply: totalSupply,
    tx_id: transactionId,
    pair_proof: proof
  };
}

/* =========================================================
   Public ZiranCoin explorer
   ========================================================= */

async function explorer(env) {
  const genesisRecord =
    await env.SQL_DB
      .prepare(
        "SELECT total_supply FROM genesis WHERE id=1"
      )
      .first();

  const accountCount =
    await env.SQL_DB
      .prepare(
        "SELECT COUNT(*) AS total FROM users"
      )
      .first();

  const transactionCount =
    await env.SQL_DB
      .prepare(
        "SELECT COUNT(*) AS total FROM transactions"
      )
      .first();

  const transferCount =
    await env.SQL_DB
      .prepare(
        "SELECT COUNT(*) AS total FROM transactions WHERE tx_type='TRANSFER'"
      )
      .first();

  const walletTotal =
    await env.SQL_DB
      .prepare(
        "SELECT COALESCE(SUM(CAST(balance AS REAL)),0) AS total FROM wallets"
      )
      .first();

  const latest =
    await env.SQL_DB
      .prepare(
        `
        SELECT
          t.tx_id,
          t.tx_type,
          t.amount,
          t.memo,
          t.pair_proof,
          t.created_at,
          sender.public_id AS from_public_id,
          recipient.public_id AS to_public_id
        FROM transactions t
        LEFT JOIN users sender
          ON sender.id = t.from_user_id
        LEFT JOIN users recipient
          ON recipient.id = t.to_user_id
        ORDER BY t.id DESC
        LIMIT 25
        `
      )
      .all();

  return {
    ok: true,
    supply:
      genesisRecord?.total_supply || "0",
    circulating:
      String(walletTotal?.total || 0),
    accounts:
      Number(accountCount?.total || 0),
    transactions:
      Number(transactionCount?.total || 0),
    transfers:
      Number(transferCount?.total || 0),
    latest:
      latest.results || []
  };
}

/* =========================================================
   JULE Store → ZiranCoin interface
   ========================================================= */

async function ensureStoreLedger(env) {
  /*
   * This matches the original production table structure.
   * It intentionally does not require a tx_id column.
   */
  await env.SQL_DB
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS jule_coin_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        amount TEXT NOT NULL,
        reason TEXT,
        external_reference TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'issued',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
      `
    )
    .run();

  await env.SQL_DB
    .prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_jule_coin_reference ON jule_coin_ledger(external_reference)"
    )
    .run();

  await env.SQL_DB
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_jule_coin_email ON jule_coin_ledger(email)"
    )
    .run();
}

async function issueStoreCoin(request, env) {
  if (!env.COIN_API_KEY) {
    fail(
      "COIN_API_KEY is not configured.",
      500
    );
  }

  const authorization =
    request.headers.get("Authorization") || "";

  const expectedAuthorization =
    `Bearer ${String(env.COIN_API_KEY).trim()}`;

  if (
    !secureEqual(
      authorization,
      expectedAuthorization
    )
  ) {
    fail("Unauthorized.", 401);
  }

  await ensureStoreLedger(env);

  const data = await readJson(request);

  const email = emailOf(data.email);
  const amount =
    amountUnits(data.amount || "1");
  const amountString =
    amountText(amount);

  const reason = clean(
    data.reason ||
    "JULE Starter License",
    160
  );

  const reference = clean(
    data.reference,
    220
  );

  if (!validEmail(email)) {
    fail(
      "Valid customer email required."
    );
  }

  if (!reference) {
    fail(
      "Payment reference is required."
    );
  }

  /*
   * Idempotency:
   * a Stripe Checkout Session can credit Coin only once.
   */
  const existingIssue =
    await env.SQL_DB
      .prepare(
        "SELECT status,email,amount FROM jule_coin_ledger WHERE external_reference=?"
      )
      .bind(reference)
      .first();

  if (existingIssue) {
    const existingUser =
      await env.SQL_DB
        .prepare(
          "SELECT id,public_id,email FROM users WHERE email=?"
        )
        .bind(email)
        .first();

    const existingWallet =
      existingUser
        ? await env.SQL_DB
            .prepare(
              "SELECT balance FROM wallets WHERE user_id=?"
            )
            .bind(existingUser.id)
            .first()
        : null;

    return {
      ok: true,
      duplicate: true,
      status:
        existingIssue.status || "issued",
      coin: "ZiranCoin",
      email,
      amount:
        existingIssue.amount ||
        amountString,
      balance:
        existingWallet?.balance || "0",
      public_id:
        existingUser?.public_id || null,
      reference
    };
  }

  /*
   * Locate or create a normal independent ZiranCoin account.
   */
  let recipient =
    await env.SQL_DB
      .prepare(
        "SELECT * FROM users WHERE email=?"
      )
      .bind(email)
      .first();

  if (!recipient) {
    const publicId =
      `ZR-${randomHex(8).toUpperCase()}`;

    const pairId =
      `PAIR-${randomHex(16).toUpperCase()}`;

    const defaultName =
      clean(
        data.name ||
        email.split("@")[0] ||
        "JULE Customer",
        80
      );

    const inserted =
      await env.SQL_DB
        .prepare(
          "INSERT INTO users(public_id,pair_id,name,email) VALUES(?,?,?,?)"
        )
        .bind(
          publicId,
          pairId,
          defaultName,
          email
        )
        .run();

    const recipientId =
      inserted.meta.last_row_id;

    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(recipientId, "0")
      .run();

    recipient =
      await env.SQL_DB
        .prepare(
          "SELECT * FROM users WHERE id=?"
        )
        .bind(recipientId)
        .first();
  }

  if (!recipient) {
    fail(
      "Recipient account could not be created.",
      500
    );
  }

  /*
   * Repair an old/new user that exists without a wallet.
   */
  let recipientWallet =
    await env.SQL_DB
      .prepare(
        "SELECT balance FROM wallets WHERE user_id=?"
      )
      .bind(recipient.id)
      .first();

  if (!recipientWallet) {
    await env.SQL_DB
      .prepare(
        "INSERT INTO wallets(user_id,balance) VALUES(?,?)"
      )
      .bind(recipient.id, "0")
      .run();

    recipientWallet = {
      balance: "0"
    };
  }

  /*
   * Genesis already exists. We only read its owner.
   * We do not recreate Genesis and do not increase supply.
   */
  const genesisRecord =
    await env.SQL_DB
      .prepare(
        "SELECT owner_user_id,total_supply FROM genesis WHERE id=1"
      )
      .first();

  if (!genesisRecord) {
    fail(
      "Genesis record was not found.",
      409
    );
  }

  if (
    Number(genesisRecord.owner_user_id) ===
    Number(recipient.id)
  ) {
    fail(
      "Store recipient cannot be the Genesis owner.",
      409
    );
  }

  const owner =
    await env.SQL_DB
      .prepare(
        "SELECT * FROM users WHERE id=?"
      )
      .bind(genesisRecord.owner_user_id)
      .first();

  if (!owner) {
    fail(
      "Genesis owner account was not found.",
      409
    );
  }

  const ownerWallet =
    await env.SQL_DB
      .prepare(
        "SELECT balance FROM wallets WHERE user_id=?"
      )
      .bind(owner.id)
      .first();

  if (!ownerWallet) {
    fail(
      "Genesis owner wallet was not found.",
      409
    );
  }

  const ownerBalance =
    amountUnitsZero(ownerWallet.balance);

  const recipientBalance =
    amountUnitsZero(recipientWallet.balance);

  if (ownerBalance < amount) {
    fail(
      "Genesis owner has insufficient balance.",
      409
    );
  }

  const nextOwnerBalance =
    ownerBalance - amount;

  const nextRecipientBalance =
    recipientBalance + amount;

  const transactionId =
    `STORE-${randomHex(18).toUpperCase()}`;

  const transactionMemo =
    `JULE_PURCHASE: ${reason}`;

  const proof = await sha256(
    [
      transactionId,
      owner.pair_id,
      recipient.pair_id,
      amountString,
      reason,
      reference
    ].join("|")
  );

  /*
   * IMPORTANT:
   * The live transactions table currently permits:
   *
   * CHECK(tx_type IN ('GENESIS','TRANSFER'))
   *
   * Therefore this commercial Coin credit is recorded as:
   * tx_type = TRANSFER
   * memo = JULE_PURCHASE: ...
   *
   * This avoids the proven D1 CHECK constraint failure while
   * preserving the commercial transaction meaning.
   */
  await env.SQL_DB.batch([
    env.SQL_DB
      .prepare(
        "UPDATE wallets SET balance=? WHERE user_id=?"
      )
      .bind(
        amountText(nextOwnerBalance),
        owner.id
      ),

    env.SQL_DB
      .prepare(
        "UPDATE wallets SET balance=? WHERE user_id=?"
      )
      .bind(
        amountText(nextRecipientBalance),
        recipient.id
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO transactions(tx_id,tx_type,from_user_id,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        "TRANSFER",
        owner.id,
        recipient.id,
        amountString,
        transactionMemo,
        proof
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        owner.id,
        recipient.id,
        "DEBIT",
        amountString,
        amountText(nextOwnerBalance)
      ),

    env.SQL_DB
      .prepare(
        "INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)"
      )
      .bind(
        transactionId,
        recipient.id,
        owner.id,
        "CREDIT",
        amountString,
        amountText(nextRecipientBalance)
      ),

    env.SQL_DB
      .prepare(
        `
        INSERT INTO jule_coin_ledger
        (
          email,
          amount,
          reason,
          external_reference,
          status,
          created_at
        )
        VALUES(?,?,?,?,?,unixepoch())
        `
      )
      .bind(
        email,
        amountString,
        reason,
        reference,
        "issued"
      )
  ]);

  return {
    ok: true,
    duplicate: false,
    status: "issued",
    coin: "ZiranCoin",
    email,
    public_id: recipient.public_id,
    amount: amountString,
    balance:
      amountText(nextRecipientBalance),
    tx_id: transactionId,
    pair_proof: proof,
    reference
  };
}

/* =========================================================
   JSON request helper
   ========================================================= */

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    fail("Valid JSON request body required.");
  }
}
