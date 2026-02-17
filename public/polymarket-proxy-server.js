#!/usr/bin/env node
/**
 * Polymarket Order Relay Proxy
 * Deploy on US VPS (35.229.117.3:3128)
 * 
 * npm install express node-fetch@2
 * node polymarket-proxy-server.js
 */
const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = 3128;

app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: Date.now() }));

app.post("/submit-order", async (req, res) => {
  try {
    // Accept BOTH formats:
    // Format A (edge fn): { order, polyHeaders, targetUrl }
    // Format B (legacy):  { signedOrder, headers }
    const order = req.body.order || req.body.signedOrder;
    const clobHeaders = req.body.polyHeaders || req.body.headers;
    const targetUrl = req.body.targetUrl || "https://clob.polymarket.com/order";

    if (!order || !clobHeaders) {
      return res.status(400).json({ error: "Missing order/signedOrder or polyHeaders/headers" });
    }

    console.log(`[${new Date().toISOString()}] Submitting order to ${targetUrl}...`);

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clobHeaders },
      body: JSON.stringify(order),
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    console.log(`[${new Date().toISOString()}] Response ${response.status}: ${text.slice(0, 300)}`);

    res.status(response.status).json({
      success: response.ok,
      status: response.status,
      data,
      orderID: data?.orderID || data?.order_id || null,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Proxy error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Polymarket relay proxy on 0.0.0.0:${PORT}`);
});
