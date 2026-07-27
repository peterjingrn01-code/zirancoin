const APK_OBJECT_KEY = "JULE-Browser-Android-1.0.apk";
const DOWNLOAD_TTL_SECONDS = 600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          worker: "jule-store-v2.0.2",
          d1: Boolean(env.DB),
          r2: Boolean(env.DOWNLOADS),
          stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID),
          coin_api: Boolean(env.COIN_API_KEY),
          price_id: env.STRIPE_PRICE_ID || null
        });
      }

      if (url.pathname === "/api/create-checkout" && request.method === "POST") {
        return createCheckout(request, env);
      }

      if (url.pathname === "/api/claim" && request.method === "GET") {
        return claimPurchase(url, env);
      }

      if (url.pathname === "/api/download" && request.method === "GET") {
        return downloadApk(url, env);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({
          error: "API route not found.",
          path: url.pathname,
          method: request.method
        }, 404);
      }

      // Static website fallback. This guard also prevents the Edit Code preview
      // from crashing when the ASSETS binding is unavailable there.
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }

      return json({ error: "Static assets binding is unavailable." }, 503);
    } catch (error) {
      console.error("JULE Store error:", error);
      return json({
        error: error?.message || "JULE Store request failed."
      }, error?.status || 500);
    }
  }
};

async function createCheckout(request, env) {
  need(env, ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]);

  const origin = new URL(request.url).origin;
  const form = new URLSearchParams();

  form.set("mode", "payment");
  form.set("line_items[0][price]", String(env.STRIPE_PRICE_ID).trim());
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${origin}/cancel.html`);
  form.set("customer_creation", "always");
  form.set("metadata[product]", "JULE Starter License");
  form.set("metadata[coin_credit]", "1");

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(env.STRIPE_SECRET_KEY).trim()}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  const data = await response.json();

  if (!response.ok || !data.url) {
    throw new Error(data?.error?.message || "Stripe Checkout creation failed.");
  }

  return json({ url: data.url });
}

async function claimPurchase(url, env) {
  need(env, ["DB", "DOWNLOADS", "STRIPE_SECRET_KEY"]);

  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  if (!sessionId.startsWith("cs_")) {
    return json({ error: "Invalid Stripe session ID." }, 400);
  }

  const session = await stripeSession(sessionId, env);

  if (session.payment_status !== "paid") {
    return json({ error: "Payment is not complete." }, 402);
  }

  const email = String(
    session.customer_details?.email ||
    session.customer_email ||
    ""
  ).trim().toLowerCase();

  if (!email) {
    return json({ error: "Customer email was not returned by Stripe." }, 400);
  }

  let row = await env.DB.prepare(
    `SELECT license_key, coin_status, download_token, download_expires_at
       FROM licenses
      WHERE stripe_session_id = ?`
  ).bind(sessionId).first();

  if (!row) {
    const licenseKey = createLicense();
    const downloadToken = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;

    await env.DB.prepare(
      `INSERT INTO licenses
       (stripe_session_id,email,license_key,amount_cents,currency,
        coin_status,download_token,download_expires_at,downloaded_at,created_at)
       VALUES (?,?,?,?,?,'pending',?,?,NULL,unixepoch())`
    ).bind(
      sessionId,
      email,
      licenseKey,
      Number(session.amount_total || 199),
      String(session.currency || "usd"),
      downloadToken,
      expiresAt
    ).run();

    row = {
      license_key: licenseKey,
      coin_status: "pending",
      download_token: downloadToken,
      download_expires_at: expiresAt
    };
  }

  // Retry a previously failed/pending Coin credit safely. ZiranCoin uses the
  // Stripe session ID as an idempotency reference, so the same payment cannot
  // issue the Coin twice.
  if (row.coin_status !== "issued") {
    const coinStatus = await issueCoin(email, sessionId, env);

    await env.DB.prepare(
      `UPDATE licenses SET coin_status = ? WHERE stripe_session_id = ?`
    ).bind(coinStatus, sessionId).run();

    row.coin_status = coinStatus;
  }

  return json({
    ok: true,
    license_key: row.license_key,
    coin_status: row.coin_status || "pending",
    download_url:
      `${url.origin}/api/download?token=${encodeURIComponent(row.download_token)}`
  });
}

async function stripeSession(sessionId, env) {
  const endpoint =
    "https://api.stripe.com/v1/checkout/sessions/" +
    encodeURIComponent(sessionId);

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${String(env.STRIPE_SECRET_KEY).trim()}`
    }
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Stripe returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || "Stripe verification failed.");
  }

  return data;
}

async function issueCoin(email, sessionId, env) {
  if (!env.COIN_API_KEY) {
    console.error("COIN_API_KEY is missing.");
    return "pending";
  }

  try {
    const rawUrl = String(
      env.COIN_API_URL || "https://zirancoin.jsl-ian.com/api/issue-coin"
    ).trim();
    const coinUrl = new URL(rawUrl);

    const response = await fetch(coinUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(env.COIN_API_KEY).trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: 1,
        reason: "JULE Starter License",
        reference: sessionId
      })
    });

    const text = await response.text();
    let result = {};

    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      console.error("Coin API returned non-JSON:", text.slice(0, 300));
      return "failed";
    }

    if (!response.ok || !result.ok) {
      console.error("Coin API failure:", response.status, result);
      return "failed";
    }

    return result.status === "issued" || result.duplicate ? "issued" : "failed";
  } catch (error) {
    console.error("Coin API request error:", error);
    return "failed";
  }
}

async function downloadApk(url, env) {
  need(env, ["DB", "DOWNLOADS"]);

  const token = String(url.searchParams.get("token") || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return json({ error: "Invalid download token." }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `SELECT download_expires_at, downloaded_at
       FROM licenses
      WHERE download_token = ?`
  ).bind(token).first();

  if (!row) return json({ error: "Download token not found." }, 404);
  if (row.downloaded_at) return json({ error: "Download link already used." }, 410);
  if (Number(row.download_expires_at) < now) {
    return json({ error: "Download link expired." }, 410);
  }

  const object = await env.DOWNLOADS.get(APK_OBJECT_KEY);
  if (!object) return json({ error: "APK file is missing from R2." }, 404);

  await env.DB.prepare(
    `UPDATE licenses SET downloaded_at = unixepoch()
      WHERE download_token = ?`
  ).bind(token).run();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/vnd.android.package-archive");
  headers.set("Content-Disposition", `attachment; filename="${APK_OBJECT_KEY}"`);
  headers.set("Cache-Control", "private, no-store");

  return new Response(object.body, { headers });
}

function createLicense() {
  const value = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  return `JULE-${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}-${value.slice(15, 20)}`;
}

function need(env, names) {
  const missing = names.filter(name => !env[name]);
  if (missing.length) {
    const error = new Error(
      "Missing Worker binding or secret: " + missing.join(", ")
    );
    error.status = 500;
    throw error;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
