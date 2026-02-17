#!/usr/bin/env node
/**
 * Polymarket CLOB Relay Server
 * Deploy on Railway / Fly.io / Render (US region)
 * 
 * Forwards signed orders to Polymarket's CLOB API from a US IP.
 * 
 * Setup:
 *   npm init -y
 *   npm install express
 *   node index.js
 * 
 * Environment:
 *   PORT (optional, default 3000)
 *   RELAY_SECRET (optional, shared secret for auth)
 */

const express = require("express");
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
  res.json({ status: "ok", region: process.env.RAILWAY_REGION || process.env.FLY_REGION || "unknown", ts: Date.now() });
});

// Generic proxy: POST /proxy
// Body: { url, method, headers, body }
app.post("/proxy", async (req, res) => {
  const { url, method = "POST", headers = {}, body } = req.body;

  if (!url) return res.status(400).json({ error: "Missing 'url'" });

  try {
    console.log(`[${new Date().toISOString()}] ${method} ${url}`);

    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    console.log(`[${new Date().toISOString()}] Response ${resp.status}: ${text.slice(0, 200)}`);

    res.status(resp.status).json({
      success: resp.ok,
      status: resp.status,
      data,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Proxy error:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Shortcut: POST /order — forwards directly to Polymarket CLOB
// Body: { order (the signed order object), headers (POLY auth headers) }
app.post("/order", async (req, res) => {
  const { order, headers: polyHeaders } = req.body;

  if (!order || !polyHeaders) {
    return res.status(400).json({ error: "Missing 'order' or 'headers'" });
  }

  try {
    console.log(`[${new Date().toISOString()}] Submitting order to Polymarket CLOB...`);

    const resp = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...polyHeaders },
      body: JSON.stringify(order),
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Polymarket relay listening on 0.0.0.0:${PORT}`);
});
