
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
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      let body;
      if (url.pathname === "/api/health" && request.method === "GET") {
        body = { ok: true, service: "ziran2-api", auth: "resend-only" };
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
      } else {
        return reply({ error: "Not found" }, 404, cors);
      }
      return reply(body, 200, cors);
    } catch (error) {
      return reply({ error: error.message || "Request failed" }, error.status || 400, cors);
    }
  }
};

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }
  });
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function emailOf(v) { return String(v || "").trim().toLowerCase(); }
function clean(v, n = 160) { return String(v || "").trim().slice(0, n); }
function randomHex(bytes = 24) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}
function code6() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}
async function sha256(v) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))]
    .map(x => x.toString(16).padStart(2, "0")).join("");
}
async function otpHash(email, code, env) {
  if (!env.OTP_SECRET) fail("OTP_SECRET is not configured.", 500);
  return sha256(`${email}|${code}|${env.OTP_SECRET}`);
}
async function sendCode(request, env) {
  if (!env.RESEND_API_KEY) fail("RESEND_API_KEY is not configured.", 500);
  if (!env.RESEND_FROM_EMAIL) fail("RESEND_FROM_EMAIL is not configured.", 500);

  const d = await request.json();
  const email = emailOf(d.email);
  const intent = d.intent === "signin" ? "signin" : "signup";
  const name = clean(d.name, 80);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Valid email required.");
  const user = await env.SQL_DB.prepare("SELECT id,name FROM users WHERE email=?").bind(email).first();

  if (intent === "signup") {
    if (user) fail("This email already has an account.", 409);
    if (name.length < 2) fail("Name is required.");
  } else if (!user) {
    fail("No account found for this email.", 404);
  }

  if (await env.DB.get(`otp-cooldown:${email}`)) {
    fail("Please wait one minute before requesting another code.", 429);
  }

  const code = code6();
  const createdAt = new Date().toISOString();
  await env.DB.put(`otp:${email}`, JSON.stringify({
    hash: await otpHash(email, code, env),
    intent,
    name: intent === "signup" ? name : user.name,
    attempts: 0
  }), { expirationTtl: OTP_TTL });
  await env.DB.put(`otp-cooldown:${email}`, "1", { expirationTtl: OTP_COOLDOWN });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
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
  const d = await request.json();
  const email = emailOf(d.email);
  const code = String(d.code || "").trim();
  if (!/^\d{6}$/.test(code)) fail("Enter the six-digit code.");

  const key = `otp:${email}`;
  const raw = await env.DB.get(key);
  if (!raw) fail("Code expired or was not requested.", 410);

  const record = JSON.parse(raw);
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.DB.delete(key); fail("Too many attempts. Request a new code.", 429);
  }
  if (await otpHash(email, code, env) !== record.hash) {
    record.attempts += 1;
    await env.DB.put(key, JSON.stringify(record), { expirationTtl: OTP_TTL });
    fail("Incorrect verification code.", 401);
  }

  let user = await env.SQL_DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  if (record.intent === "signup") {
    if (user) { await env.DB.delete(key); fail("Account already exists.", 409); }
    const publicId = `ZR-${randomHex(8).toUpperCase()}`;
    const pairId = `PAIR-${randomHex(16).toUpperCase()}`;
    const inserted = await env.SQL_DB.prepare(
      "INSERT INTO users(public_id,pair_id,name,email) VALUES(?,?,?,?)"
    ).bind(publicId, pairId, record.name, email).run();
    await env.SQL_DB.prepare("INSERT INTO wallets(user_id,balance) VALUES(?,?)")
      .bind(inserted.meta.last_row_id, "0").run();
    user = await env.SQL_DB.prepare("SELECT * FROM users WHERE id=?")
      .bind(inserted.meta.last_row_id).first();
  } else if (!user) {
    await env.DB.delete(key); fail("Account no longer exists.", 404);
  }

  await env.DB.delete(key);
  if (user.pair_status !== "ACTIVE") fail("Account Pair is locked.", 403);

  const token = randomHex(32);
  await env.DB.put(`session:${token}`, String(user.id), { expirationTtl: 604800 });
  return { ok: true, token, user: { name: user.name, email: user.email, public_id: user.public_id } };
}
async function auth(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) fail("Unauthorized", 401);
  const id = await env.DB.get(`session:${h.slice(7)}`);
  if (!id) fail("Unauthorized", 401);
  const user = await env.SQL_DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  if (!user) fail("Unauthorized", 401);
  return user;
}
function amountUnits(v) {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) fail("Invalid amount.");
  const [a,b=""] = s.split(".");
  const n = BigInt(a) * SCALE + BigInt((b+"00000000").slice(0,8));
  if (n <= 0n) fail("Amount must be greater than zero.");
  return n;
}
function amountUnits0(v) {
  const [a,b=""] = String(v || "0").split(".");
  return BigInt(a) * SCALE + BigInt((b+"00000000").slice(0,8));
}
function amountText(n) {
  const a=n/SCALE, b=(n%SCALE).toString().padStart(8,"0").replace(/0+$/,"");
  return b ? `${a}.${b}` : `${a}`;
}
async function me(request, env) {
  const u = await auth(request, env);
  const w = await env.SQL_DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(u.id).first();
  const g = await env.SQL_DB.prepare("SELECT total_supply FROM genesis WHERE id=1").first();
  const l = await env.SQL_DB.prepare(
    "SELECT l.*,cp.email counterparty_email FROM ledger l LEFT JOIN users cp ON cp.id=l.counterparty_user_id WHERE l.user_id=? ORDER BY l.id DESC LIMIT 100"
  ).bind(u.id).all();
  return { user:{name:u.name,email:u.email,public_id:u.public_id,pair_status:u.pair_status},
    wallet:{balance:w.balance}, supply:g?.total_supply||"0", ledger:l.results };
}
async function transfer(request, env) {
  const from = await auth(request, env), d = await request.json();
  const toEmail = emailOf(d.to_email);
  if (toEmail === from.email) fail("Cannot send to the same account.");
  const to = await env.SQL_DB.prepare("SELECT * FROM users WHERE email=?").bind(toEmail).first();
  if (!to) fail("Recipient not found.", 404);

  const amount = amountUnits(d.amount), amountStr = amountText(amount);
  const fw = await env.SQL_DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(from.id).first();
  const tw = await env.SQL_DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(to.id).first();
  const fb = amountUnits0(fw.balance), tb = amountUnits0(tw.balance);
  if (fb < amount) fail("Insufficient balance.");

  const txId = `TX-${randomHex(20).toUpperCase()}`;
  const proof = await sha256([txId,from.pair_id,to.pair_id,amountStr,new Date().toISOString()].join("|"));
  const nf = fb-amount, nt = tb+amount;
  await env.SQL_DB.batch([
    env.SQL_DB.prepare("UPDATE wallets SET balance=? WHERE user_id=?").bind(amountText(nf),from.id),
    env.SQL_DB.prepare("UPDATE wallets SET balance=? WHERE user_id=?").bind(amountText(nt),to.id),
    env.SQL_DB.prepare("INSERT INTO transactions(tx_id,tx_type,from_user_id,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?,?)")
      .bind(txId,"TRANSFER",from.id,to.id,amountStr,clean(d.memo),proof),
    env.SQL_DB.prepare("INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)")
      .bind(txId,from.id,to.id,"DEBIT",amountStr,amountText(nf)),
    env.SQL_DB.prepare("INSERT INTO ledger(tx_id,user_id,counterparty_user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?,?)")
      .bind(txId,to.id,from.id,"CREDIT",amountStr,amountText(nt))
  ]);
  return {ok:true,tx_id:txId,pair_proof:proof};
}
async function genesis(request, env) {
  const d = await request.json();
  if (!env.GENESIS_KEY) fail("GENESIS_KEY is not configured.",500);
  if (String(d.genesis_key)!==env.GENESIS_KEY) fail("Invalid genesis key.",403);
  if (await env.SQL_DB.prepare("SELECT id FROM genesis WHERE id=1").first()) fail("Genesis already completed.",409);
  const owner = await env.SQL_DB.prepare("SELECT * FROM users WHERE email=?").bind(emailOf(d.owner_email)).first();
  if (!owner) fail("Owner account must exist.",404);

  const txId=`GENESIS-${randomHex(18).toUpperCase()}`;
  const amount=amountText(SUPPLY*SCALE);
  const proof=await sha256([txId,owner.pair_id,amount,"GENESIS"].join("|"));
  await env.SQL_DB.batch([
    env.SQL_DB.prepare("INSERT INTO genesis(id,tx_id,owner_user_id,total_supply,pair_proof) VALUES(1,?,?,?,?)").bind(txId,owner.id,amount,proof),
    env.SQL_DB.prepare("UPDATE wallets SET balance=? WHERE user_id=?").bind(amount,owner.id),
    env.SQL_DB.prepare("INSERT INTO transactions(tx_id,tx_type,to_user_id,amount,memo,pair_proof) VALUES(?,?,?,?,?,?)").bind(txId,"GENESIS",owner.id,amount,"One-time genesis 1B",proof),
    env.SQL_DB.prepare("INSERT INTO ledger(tx_id,user_id,entry_type,amount,balance_after) VALUES(?,?,?,?,?)").bind(txId,owner.id,"CREDIT",amount,amount)
  ]);
  return {ok:true,supply:amount,tx_id:txId,pair_proof:proof};
}
async function explorer(env) {
  const g=await env.SQL_DB.prepare("SELECT total_supply FROM genesis WHERE id=1").first();
  const accounts=(await env.SQL_DB.prepare("SELECT COUNT(*) n FROM users").first()).n;
  const transfers=(await env.SQL_DB.prepare("SELECT COUNT(*) n FROM transactions WHERE tx_type='TRANSFER'").first()).n;
  const circulating=(await env.SQL_DB.prepare("SELECT COALESCE(SUM(CAST(balance AS REAL)),0) n FROM wallets").first()).n;
  const latest=await env.SQL_DB.prepare(
    "SELECT t.tx_id,t.amount,t.pair_proof,t.created_at,fu.public_id from_public_id,tu.public_id to_public_id FROM transactions t LEFT JOIN users fu ON fu.id=t.from_user_id JOIN users tu ON tu.id=t.to_user_id ORDER BY t.id DESC LIMIT 50"
  ).all();
  return {supply:g?.total_supply||"0",circulating:String(circulating),accounts,transfers,latest:latest.results};
}
