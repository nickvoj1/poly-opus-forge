#!/usr/bin/env node
/**
 * Polymarket Order Relay Proxy
 * Deploy on US VPS (35.229.117.3)
 * 
 * Usage:
 *   npm install express node-fetch
 *   node polymarket-proxy-server.js
 * 
 * Listens on port 3128, forwards signed orders to Polymarket CLOB API.
 */

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = 3128;
const CLOB_URL = "https://clob.polymarket.com";

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Submit signed order to Polymarket
app.post("/submit-order", async (req, res) => {
  try {
    const { signedOrder, headers: clobHeaders } = req.body;

    if (!signedOrder || !clobHeaders) {
      return res.status(400).json({ error: "Missing signedOrder or headers" });
    }

    console.log(`[${new Date().toISOString()}] Submitting order...`);

    const response = await fetch(`${CLOB_URL}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...clobHeaders,
      },
      body: JSON.stringify(signedOrder),
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    console.log(`[${new Date().toISOString()}] Response ${response.status}:`, text.slice(0, 200));

    res.status(response.status).json({
      success: response.ok,
      status: response.status,
      data,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Proxy error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Polymarket proxy listening on 0.0.0.0:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Submit: POST http://localhost:${PORT}/submit-order`);
});
