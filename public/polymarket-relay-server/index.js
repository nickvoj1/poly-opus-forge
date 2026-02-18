#!/usr/bin/env node
/**
 * Polymarket CLOB Relay Server (with native order signing)
 * Deploy on Railway / Fly.io / Render (US region)
 *
 * Signs and submits orders to Polymarket's CLOB API using @polymarket/clob-client.
 * No need for separate order signing — just send trade params.
 *
 * Environment:
 *   PORT (optional, default 3000)
 *   RELAY_SECRET (optional, shared secret for auth)
 *   POLYMARKET_PRIVATE_KEY (EOA private key)
 *   PROXY_WALLET_ADDRESS (Polymarket proxy wallet)
 *   POLYMARKET_API_KEY (L2 API key, optional - will derive if missing)
 *   POLYMARKET_API_SECRET (L2 secret, optional)
 *   POLYMARKET_PASSPHRASE (L2 passphrase, optional)
 */

const express = require("express");
const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
const { Wallet } = require("ethers");

const app = express();
const PORT = process.env.PORT || 3000;
const RELAY_SECRET = process.env.RELAY_SECRET || "";

app.use(express.json({ limit: "1mb" }));

// Auth middleware
app.use((req, res, next) => {
  if (RELAY_SECRET && req.headers["x-relay-secret"] !== RELAY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    region: process.env.RAILWAY_REGION || process.env.FLY_REGION || "unknown",
    hasWallet: !!process.env.POLYMARKET_PRIVATE_KEY,
    hasProxy: !!process.env.PROXY_WALLET_ADDRESS,
    hasL2Creds: !!(process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET),
    ts: Date.now(),
  });
});

// Cache for authenticated client
let cachedClient = null;
let cachedCreds = null;

async function getAuthedClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const proxyAddr = process.env.PROXY_WALLET_ADDRESS;

  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY not set");

  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const funder = proxyAddr || wallet.address;
  const sigType = proxyAddr ? 2 : 0; // 2 = Gnosis Safe/Proxy, 0 = EOA

  // Use stored L2 creds if available
  if (process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_PASSPHRASE) {
    if (cachedClient) return cachedClient;

    cachedCreds = {
      key: process.env.POLYMARKET_API_KEY,
      secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_PASSPHRASE,
    };

    cachedClient = new ClobClient("https://clob.polymarket.com", 137, wallet, cachedCreds, sigType, funder);

    console.log(`✅ Client initialized with stored L2 creds (sigType=${sigType}, funder=${funder.substring(0, 10)})`);
    return cachedClient;
  }

  // Derive API key if not stored
  if (cachedClient) return cachedClient;

  console.log("Deriving API key...");
  const initClient = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, sigType, funder);

  let creds;
  try {
    creds = await initClient.deriveApiKey();
  } catch {
    creds = await initClient.createOrDeriveApiKey();
  }

  cachedCreds = { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase };
  cachedClient = new ClobClient("https://clob.polymarket.com", 137, wallet, cachedCreds, sigType, funder);

  console.log(`✅ Client initialized with derived creds (apiKey=${creds.apiKey?.substring(0, 8)})`);
  return cachedClient;
}

// ── NEW: POST /trade — sign + submit order using clob-client ──
// Body: { tokenId, side: "BUY"|"SELL", amount, price?, orderType?: "FAK"|"FOK" }
app.post("/trade", async (req, res) => {
  const { tokenId, side, amount, price, size, orderType = "FAK" } = req.body;

  if (!tokenId || !side || (!amount && !size)) {
    return res.status(400).json({ error: "Missing: tokenId, side, amount/size" });
  }

  const tradeAmount = amount || size;

  try {
    const client = await getAuthedClient();

    // Get tick size from orderbook
    let tickSize = "0.01";
    try {
      const book = await client.getOrderBook(tokenId);
      if (book?.market?.minimum_tick_size) tickSize = book.market.minimum_tick_size;
    } catch (e) {
      console.log("Tick size lookup failed, using default 0.01");
    }

    // Get midpoint if no price specified
    let tradePrice = price;
    if (!tradePrice) {
      try {
        const mid = await client.getMidpoint(tokenId);
        tradePrice = parseFloat(mid);
      } catch {
        tradePrice = 0.5;
      }
    }

    // Round price to tick
    const tick = parseFloat(tickSize);
    const roundedPrice = Math.round(tradePrice / tick) * tick;
    const finalPrice = Math.max(tick, Math.min(1 - tick, roundedPrice));

    // Round amount to 2 decimal places
    const roundedAmount = Math.round(tradeAmount * 100) / 100;

    const tradeSide = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;
    const oType = orderType === "FOK" ? OrderType.FOK : OrderType.FAK;

    console.log(
      `[${new Date().toISOString()}] 🔄 ${side} $${roundedAmount} of ${tokenId.substring(0, 20)}... @ $${finalPrice} (${orderType}, tick=${tickSize})`,
    );

    // createAndPostMarketOrder handles signing + submission in one call
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            size: roundedAmount,
            price: finalPrice,
            side: tradeSide,
          },
          undefined,
          oType,
        );

        if (result.success) {
          console.log(`[${new Date().toISOString()}] ✅ Order filled:`, JSON.stringify(result).substring(0, 300));
          return res.json({
            success: true,
            submitted: true,
            orderID: result.orderID || result.order_id || null,
            data: result,
            finalPrice,
            tickSize,
            attempt,
          });
        } else {
          lastError = result.error || result.errorMsg || "Order rejected";
          console.log(`[${new Date().toISOString()}] ⚠ Attempt ${attempt} failed: ${lastError}`);
        }
      } catch (err) {
        lastError = err.message;
        console.log(`[${new Date().toISOString()}] ⚠ Attempt ${attempt} error: ${lastError}`);
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    console.error(`[${new Date().toISOString()}] ❌ All ${maxRetries} attempts failed: ${lastError}`);
    res.status(400).json({ success: false, submitted: false, error: lastError, finalPrice, tickSize });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Trade error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy: POST /order — forwards pre-signed orders ──
app.post("/order", async (req, res) => {
  const { order, headers: polyHeaders } = req.body;

  if (!order || !polyHeaders) {
    return res.status(400).json({ error: "Missing 'order' or 'headers'" });
  }

  try {
    console.log(`[${new Date().toISOString()}] Submitting pre-signed order to Polymarket CLOB...`);

    const resp = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...polyHeaders },
      body: JSON.stringify(order),
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    console.log(`[${new Date().toISOString()}] CLOB ${resp.status}: ${text.slice(0, 300)}`);

    res.status(resp.status).json({
      success: resp.ok,
      status: resp.status,
      data,
      orderID: data?.orderID || null,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Order error:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Generic proxy ──
app.post("/proxy", async (req, res) => {
  const { url, method = "POST", headers = {}, body } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url'" });

  try {
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    res.status(resp.status).json({ success: resp.ok, status: resp.status, data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Polymarket relay (with clob-client) on 0.0.0.0:${PORT}`);
});
