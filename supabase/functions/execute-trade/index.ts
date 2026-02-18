import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const RELAY_URL = "https://poly-order-relay-production.up.railway.app";
const CLOB_HOST = "https://clob.polymarket.com";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { tokenId, side, price, size } = await req.json();

    if (!tokenId || !side || !price || !size) {
      return json({ error: "Missing required fields: tokenId, side, price, size" }, 400);
    }

    const PRIVATE_KEY = Deno.env.get("POLYMARKET_WALLET_PRIVATE_KEY");
    const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";

    if (!PRIVATE_KEY) {
      return json({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }, 400);
    }

    console.log(`execute-trade: ${side} ${size} shares of ${tokenId.substring(0, 20)}... @ $${price}`);

    // Get live midpoint to validate price
    let finalPrice = price;
    try {
      const midRes = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
      if (midRes.ok) {
        const midData = await midRes.json();
        if (midData.mid) {
          finalPrice = parseFloat(midData.mid);
          console.log(`Live midpoint: $${finalPrice} (requested: $${price})`);
        }
      }
    } catch (e) {
      console.warn("Could not fetch midpoint, using provided price:", e);
    }

    // Round price to valid tick size (0.01)
    const tickedPrice = Math.round(finalPrice * 100) / 100;

    // Submit order to relay
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (RELAY_SECRET) headers["x-relay-secret"] = RELAY_SECRET;

    const orderPayload = {
      tokenId,
      side: side.toUpperCase(),
      amount: size,
      price: tickedPrice,
      orderType: "FAK", // Fill-and-Kill for immediate execution
    };

    console.log(`Sending to relay: ${JSON.stringify(orderPayload)}`);

    const relayRes = await fetch(`${RELAY_URL}/order`, {
      method: "POST",
      headers,
      body: JSON.stringify(orderPayload),
    });

    const relayText = await relayRes.text();
    console.log(`Relay [${relayRes.status}]: ${relayText.substring(0, 500)}`);

    let result: any;
    try {
      result = JSON.parse(relayText);
    } catch {
      result = { raw: relayText };
    }

    if (!relayRes.ok) {
      return json({
        success: false,
        submitted: false,
        error: result?.message || result?.error || `Relay error ${relayRes.status}`,
        relayStatus: relayRes.status,
        relayResponse: result,
      }, 400);
    }

    // Handle success
    if (result?.success || result?.submitted || result?.orderId || result?.orderID) {
      const orderId = result.orderId || result.orderID || result.order_id;
      console.log(`✅ Order submitted! ID: ${orderId}`);
      return json({
        success: true,
        submitted: true,
        orderId,
        status: result.status || "submitted",
        finalPrice: tickedPrice,
        result,
      });
    }

    // Relay returned 2xx but no success flag — treat as success
    return json({
      success: true,
      submitted: true,
      finalPrice: tickedPrice,
      result,
    });

  } catch (e) {
    console.error("execute-trade error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
