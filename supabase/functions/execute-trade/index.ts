import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildPolyHmacSignature } from "https://esm.sh/@polymarket/clob-client@5.2.3/dist/signing/hmac";
import { ClobClient, Side, OrderType } from "https://esm.sh/@polymarket/clob-client@5.2.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CLOB_HOST = "https://clob.polymarket.com";

function getRelayUrl() {
  let url = Deno.env.get("RELAY_SERVER_URL") || "https://poly-order-relay-production.up.railway.app";
  if (url && !url.startsWith("http")) url = `https://${url}`;
  return url;
}

async function getMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.mid ? parseFloat(data.mid) : null;
  } catch { return null; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { tokenId, side, price, size } = await req.json();

    if (!tokenId || !side || !size) {
      return json({ error: "Missing required fields: tokenId, side, size" }, 400);
    }

    const PRIVATE_KEY = Deno.env.get("POLYMARKET_WALLET_PRIVATE_KEY");
    const API_KEY = Deno.env.get("POLYMARKET_API_KEY");
    let API_SECRET = Deno.env.get("POLYMARKET_API_SECRET");
    const API_PASSPHRASE = Deno.env.get("POLYMARKET_PASSPHRASE");
    const PROXY_ADDRESS = Deno.env.get("POLYMARKET_PROXY_ADDRESS");
    const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";

    if (!PRIVATE_KEY) return json({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }, 400);
    if (!API_KEY || !API_SECRET || !API_PASSPHRASE) return json({ error: "Polymarket API credentials not configured" }, 400);

    // Fix base64 padding
    if (API_SECRET.length % 4 !== 0) {
      API_SECRET += "=".repeat(4 - (API_SECRET.length % 4));
    }

    // Derive wallet
    const { ethers } = await import("https://esm.sh/ethers@5.7.2");
    const pk = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
    const wallet = new ethers.Wallet(pk);
    const eoaAddress = wallet.address;
    const funderAddress = PROXY_ADDRESS || eoaAddress;
    const sigType = PROXY_ADDRESS ? 2 : 0; // 2=proxy, 0=EOA

    // Get live price
    let finalPrice = price;
    if (!finalPrice) {
      const mid = await getMidpoint(tokenId);
      finalPrice = mid ?? 0.5;
    }
    const tickedPrice = Math.round(finalPrice * 100) / 100;
    const tradeSide = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;

    console.log(`execute-trade: ${side.toUpperCase()} ${size} @ $${tickedPrice} token=${tokenId.substring(0, 20)}... sigType=${sigType} funder=${funderAddress.substring(0, 10)}`);

    // Build L2 credentials object
    const creds = {
      key: API_KEY,
      secret: API_SECRET,
      passphrase: API_PASSPHRASE,
    };

    // Create ClobClient — points at actual CLOB to build+sign the order
    // The order is then submitted via the relay to avoid geoblocking
    const client = new ClobClient(
      CLOB_HOST,
      137,
      wallet as any,
      creds,
      sigType,
      funderAddress,
    );

    // Create the signed order
    const orderArgs = {
      tokenID: tokenId,
      price: tickedPrice,
      size,
      side: tradeSide,
      orderType: OrderType.FAK,
    };

    console.log("Creating signed order...");
    const signedOrder = await client.createOrder(orderArgs);
    console.log("Signed order created:", JSON.stringify(signedOrder).substring(0, 200));

    // Build L2 auth headers for submitting the order
    const ts = Math.floor(Date.now() / 1000);
    const orderBody = JSON.stringify({ order: signedOrder, orderType: "FAK" });
    const l2Sig = await buildPolyHmacSignature(API_SECRET, ts, "POST", "/order", orderBody);
    const polyHeaders = {
      POLY_ADDRESS: eoaAddress,
      POLY_SIGNATURE: l2Sig,
      POLY_TIMESTAMP: `${ts}`,
      POLY_API_KEY: API_KEY,
      POLY_PASSPHRASE: API_PASSPHRASE,
      "Content-Type": "application/json",
    };

    const RELAY_URL = getRelayUrl();
    const relayHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (RELAY_SECRET) relayHeaders["x-relay-secret"] = RELAY_SECRET;

    // Try /trade on relay first (full order flow, relay signs internally)
    console.log(`Trying ${RELAY_URL}/trade`);
    const tradeRes = await fetch(`${RELAY_URL}/trade`, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({ tokenId, side: side.toUpperCase(), amount: size, price: tickedPrice, orderType: "FAK" }),
    });

    if (tradeRes.ok) {
      const tradeResult = await tradeRes.json();
      if (tradeResult?.success || tradeResult?.submitted) {
        console.log(`✅ Submitted via relay /trade`);
        return json({ success: true, submitted: true, orderId: tradeResult.orderID, finalPrice: tickedPrice, result: tradeResult, via: "relay-trade" });
      }
    } else {
      const errText = await tradeRes.text();
      console.log(`Relay /trade [${tradeRes.status}]: ${errText.substring(0, 200)}`);
    }

    // Fallback: POST pre-signed order via relay's /order proxy
    console.log(`Trying ${RELAY_URL}/order (pre-signed)`);
    const orderRes = await fetch(`${RELAY_URL}/order`, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({ order: signedOrder, headers: polyHeaders }),
    });

    const orderText = await orderRes.text();
    console.log(`Relay /order [${orderRes.status}]: ${orderText.substring(0, 300)}`);

    let orderResult: any;
    try { orderResult = JSON.parse(orderText); } catch { orderResult = { raw: orderText }; }

    if (!orderRes.ok || (!orderResult?.success && orderResult?.error)) {
      return json({
        success: false,
        submitted: false,
        error: orderResult?.error || orderResult?.message || `Relay error ${orderRes.status}`,
        relayStatus: orderRes.status,
        relayResponse: orderResult,
      }, 400);
    }

    return json({
      success: true,
      submitted: true,
      orderId: orderResult?.orderID || orderResult?.orderId || orderResult?.data?.orderID,
      finalPrice: tickedPrice,
      result: orderResult,
      via: "relay-order",
    });

  } catch (e) {
    console.error("execute-trade error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
