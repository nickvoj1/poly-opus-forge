import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

function normalizeRelayTokenId(tokenId: string): string {
  const raw = tokenId.trim();
  if (raw.startsWith("0x")) return raw;
  try {
    const hex = BigInt(raw).toString(16).padStart(64, "0");
    return `0x${hex}`;
  } catch {
    return raw;
  }
}

function decimalFromHex(tokenId: string): string | null {
  try {
    if (!tokenId.startsWith("0x")) return null;
    return BigInt(tokenId).toString(10);
  } catch {
    return null;
  }
}

function tokenCandidates(tokenId: string): string[] {
  const raw = tokenId.trim();
  const hex = normalizeRelayTokenId(raw);
  const dec = raw.startsWith("0x") ? decimalFromHex(raw) : raw;
  const out = [raw, hex, dec || ""].filter(Boolean);
  return Array.from(new Set(out));
}

function parseRelayResponse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function callRelay(
  url: string,
  path: string,
  headers: Record<string, string>,
  body: any,
): Promise<{ ok: boolean; status: number; json: any; text: string; path: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = parseRelayResponse(text);
  return { ok: res.ok, status: res.status, json, text, path };
}

function isMissingRoute(r: { status: number; json: any; text: string }) {
  const txt = (r.text || "").toLowerCase();
  const msg = (r.json?.message || "").toString().toLowerCase();
  return r.status === 404 || r.status === 405 || txt.includes("cannot post") || msg.includes("not found");
}

function isMarketNotFound(r: { json: any; text: string }) {
  const err = (r.json?.error || r.json?.message || r.text || "").toString().toLowerCase();
  return err.includes("market not found");
}

async function getMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.mid ? parseFloat(data.mid) : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const payload = await req.json();

    const PRIVATE_KEY = Deno.env.get("POLYMARKET_WALLET_PRIVATE_KEY");
    const API_KEY = Deno.env.get("POLYMARKET_API_KEY");
    let API_SECRET = Deno.env.get("POLYMARKET_API_SECRET");
    const API_PASSPHRASE = Deno.env.get("POLYMARKET_PASSPHRASE");
    const PROXY_ADDRESS = Deno.env.get("POLYMARKET_PROXY_ADDRESS");
    const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";

    if (!PRIVATE_KEY) return json({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }, 400);
    if (!API_KEY || !API_SECRET || !API_PASSPHRASE)
      return json({ error: "Polymarket API credentials not configured" }, 400);

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

    // Parse + validate/fix Lovable partial payloads
    const tokenId = payload.tokenId?.toString() || payload.conditionId?.toString();
    const side = (payload.side || payload.direction)?.toUpperCase();
    const sizeStr = (payload.size || payload.amount).toString();
    const priceStr = (payload.price || payload.targetPrice || "").toString();

    if (!tokenId || (side !== "BUY" && side !== "SELL") || !sizeStr) {
      console.log("Bad payload:", JSON.stringify(payload));
      return json({ error: "Missing: tokenId, side(BUY/SELL), size" }, 400);
    }

    const parsedSize = parseFloat(sizeStr);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
      return json({ error: "Invalid size" }, 400);
    }
    const size = Math.max(5, parsedSize);

    let parsedPrice = parseFloat(priceStr);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice >= 1) {
      const midpoint = await getMidpoint(tokenId);
      parsedPrice = midpoint ?? 0.5;
    }

    const tickedPrice = Math.max(0.01, Math.min(0.99, Math.round(parsedPrice * 100) / 100));

    console.log(
      `Fixed: ${side} ${size}@${tickedPrice} token=${tokenId.slice(0, 10)} wallet=${funderAddress.slice(0, 10)}`,
    );

    const RELAY_URL = getRelayUrl();
    const relayHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (RELAY_SECRET) relayHeaders["x-relay-secret"] = RELAY_SECRET;
    const relayTokenIds = tokenCandidates(tokenId);

    // Try modern relay first (/trade), then legacy (/order), across token format variants.
    const paths = ["/trade", "/order"];

    let relay: { ok: boolean; status: number; json: any; text: string; path: string } | null = null;
    for (const path of paths) {
      for (const tid of relayTokenIds) {
        const body =
          path === "/trade"
            ? {
                tokenId: tid,
                tokenID: tid,
                side: side.toUpperCase(),
                amount: size,
                size,
                price: tickedPrice,
                orderType: "FAK",
              }
            : {
                tokenId: tid,
                tokenID: tid,
                side: side.toUpperCase(),
                size,
                price: tickedPrice,
              };
        console.log(`Trying ${RELAY_URL}${path} token=${tid.slice(0, 12)}...`);
        const r = await callRelay(RELAY_URL, path, relayHeaders, body);
        relay = r;

        // If route is missing, move to next path.
        if (isMissingRoute(r)) break;
        // If market lookup failed, try next token format on same path.
        if (isMarketNotFound(r)) continue;
        // Otherwise keep this response.
        break;
      }
      if (relay && !isMissingRoute(relay) && !isMarketNotFound(relay)) break;
    }
    if (!relay) return json({ error: "Relay call failed to initialize" }, 500);

    const tradeRes = { ok: relay.ok, status: relay.status };
    const tradeResult: any = relay.json;

    const submitted = !!(
      tradeResult?.submitted ||
      tradeResult?.success ||
      tradeResult?.status === "submitted" ||
      tradeResult?.orderId === "pending" ||
      tradeResult?.orderID === "pending" ||
      tradeResult?.data?.status === "submitted"
    );
    if (tradeRes.ok && submitted) {
      return json({
        success: true,
        submitted: true,
        orderId: tradeResult?.orderID || tradeResult?.orderId || tradeResult?.data?.orderID || "pending",
        finalPrice: tickedPrice,
        result: tradeResult,
        via: `relay${relay.path}`,
      });
    }

    if (!tradeRes.ok || tradeResult?.error) {
      return json(
        {
          success: false,
          submitted: false,
          error: tradeResult?.error || tradeResult?.message || `Relay error ${tradeRes.status}`,
          relayStatus: tradeRes.status,
          relayResponse: tradeResult,
          relayPath: relay.path,
        },
        400,
      );
    }

    return json({
      success: false,
      submitted: false,
      orderId: tradeResult?.orderID || tradeResult?.orderId || tradeResult?.data?.orderID || null,
      finalPrice: tickedPrice,
      result: tradeResult,
      via: `relay${relay.path}`,
    });
  } catch (e) {
    console.error("execute-trade error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
