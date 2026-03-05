import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildPolyHmacSignature } from "https://esm.sh/@polymarket/clob-client@5.7.0/dist/signing/hmac";
import { ClobClient } from "https://esm.sh/@polymarket/clob-client@5.7.0";
import { Side as ClobSide, OrderType } from "https://esm.sh/@polymarket/clob-client@5.7.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CLOB_HOST = "https://clob.polymarket.com";

// ── L2 HMAC Auth Headers ──
async function getL2Headers(
  apiKey: string,
  secret: string,
  passphrase: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
  walletAddress?: string,
) {
  const sig = await buildPolyHmacSignature(secret, timestamp, method, requestPath, body);
  console.log(
    "L2 HMAC:",
    JSON.stringify({
      sig: sig?.substring(0, 20),
      method,
      requestPath: requestPath?.substring(0, 40),
      apiKey: apiKey?.substring(0, 8),
      addr: walletAddress?.substring(0, 10),
    }),
  );
  return {
    POLY_ADDRESS: walletAddress || apiKey,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
}

// ── Fetch negRisk from Gamma API (not geoblocked) ──
async function fetchNegRiskFromGamma(tokenId: string, marketName?: string): Promise<boolean | null> {
  try {
    // Try clob_token_ids first
    const res = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&closed=false`);
    if (res.ok) {
      const markets = await res.json();
      if (markets.length > 0) {
        const neg = markets[0].neg_risk;
        const question = markets[0].question || "";
        console.log(`Gamma negRisk for token ${tokenId.substring(0, 12)}...: ${neg} (question: ${question.substring(0, 60)})`);
        if (neg !== undefined && neg !== null) {
          return neg === true || neg === "true";
        }
        // neg_risk is undefined — default to false (don't force true based on name patterns)
        console.log(`Gamma neg_risk undefined → defaulting to false`);
        return false;
      }
    }

    // Try searching by token_id without closed filter
    const res2 = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
    if (res2.ok) {
      const markets2 = await res2.json();
      if (markets2.length > 0) {
        const neg = markets2[0].neg_risk;
        const question = markets2[0].question || "";
        console.log(`Gamma (no filter) negRisk: ${neg} (question: ${question.substring(0, 60)})`);
        if (neg !== undefined && neg !== null) {
          return neg === true || neg === "true";
        }
        console.log(`Gamma neg_risk undefined → defaulting to false`);
        return false;
      }
    }

    return null;
  } catch (e) {
    console.error("Gamma negRisk lookup error:", e);
    return null;
  }
}

// Helper: detect crypto up/down markets that are typically negRisk=true
function isCryptoUpDownMarket(marketName?: string): boolean {
  if (!marketName) return false;
  const lower = marketName.toLowerCase();
  const cryptoPatterns = [
    /\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|doge|dogecoin|bnb|ada|cardano|avax|avalanche|matic|polygon|link|chainlink|dot|polkadot|ltc|litecoin|uni|uniswap|aave|shib|pepe|sui|apt|aptos|arb|arbitrum|op|optimism)\b/,
    /\b(crypto|coin|token)\b/,
  ];
  const upDownPatterns = [
    /up\s+or\s+down/i,
    /above|below|over|under|hit|reach|price/i,
    /by .*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /\d+[:\s]*(am|pm)\s*(et|est|edt|utc|pt|pst|ct|cst)/i,
  ];
  const isCrypto = cryptoPatterns.some(p => p.test(lower));
  const isUpDown = upDownPatterns.some(p => p.test(lower));
  console.log(`isCryptoUpDownMarket("${marketName.substring(0, 50)}"): crypto=${isCrypto}, upDown=${isUpDown}`);
  return isCrypto && isUpDown;
}

// ── Market Data Helpers ──
async function getOrderbook(tokenId: string): Promise<any> {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  return res.ok ? await res.json() : null;
}

async function getMidpoint(tokenId: string): Promise<string | null> {
  const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
  if (!res.ok) return null;
  return (await res.json()).mid;
}

async function getMarketTokens(conditionId: string): Promise<any> {
  const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
  return res.ok ? (await res.json())[0] || null : null;
}

async function searchMarkets(query: string): Promise<any[]> {
  const res = await fetch(
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10&query=${encodeURIComponent(query)}`,
  );
  return res.ok ? await res.json() : [];
}

async function getPositions(walletAddress: string): Promise<any> {
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${walletAddress}`);
  if (!res.ok) {
    console.error("Positions error:", res.status);
    return { error: await res.text() };
  }
  return await res.json();
}

// ── Wallet Balance (Polygon RPC) ──
async function getWalletBalance(walletAddress: string): Promise<{ usdc: number; matic: number }> {
  const RPC = "https://polygon-rpc.com";
  const USDC_ADDRS = ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];

  let totalUsdc = 0;
  for (const usdcAddr of USDC_ADDRS) {
    try {
      const padded = walletAddress.replace("0x", "").padStart(64, "0");
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: usdcAddr, data: `0x70a08231000000000000000000000000${padded}` }, "latest"],
          id: 1,
        }),
      });
      const data = await res.json();
      if (data.result && data.result !== "0x") totalUsdc += parseInt(data.result, 16) / 1e6;
    } catch (e) {
      console.error(`USDC balance error (${usdcAddr}):`, e);
    }
  }

  let matic = 0;
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [walletAddress, "latest"], id: 2 }),
    });
    const data = await res.json();
    if (data.result) matic = parseInt(data.result, 16) / 1e18;
  } catch {}

  return { usdc: totalUsdc, matic };
}

// ── Proxied fetch: routes request through a proxy API to bypass geoblocking ──
async function proxiedFetch(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; data: any }> {
  let PROXY_API_URL = Deno.env.get("PROXY_API_URL") || "";

  // Ensure the proxy URL has a protocol prefix
  if (PROXY_API_URL && !PROXY_API_URL.startsWith("http")) {
    PROXY_API_URL = `https://${PROXY_API_URL}`;
  }

  if (PROXY_API_URL) {
    // Route through proxy worker (Cloudflare Worker, VPS, etc.)
    console.log(`Proxying request to ${url} via ${PROXY_API_URL}`);
    const proxyRes = await fetch(PROXY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
      }),
    });
    const result = await proxyRes.json();
    return {
      ok: result.success ?? proxyRes.ok,
      status: result.status ?? proxyRes.status,
      data: result.data ?? result,
    };
  }

  // Fallback: try relay server
  let RELAY_URL = Deno.env.get("RELAY_SERVER_URL") || "";
  if (RELAY_URL && !RELAY_URL.startsWith("http")) RELAY_URL = `https://${RELAY_URL}`;
  const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";

  if (RELAY_URL) {
    console.log(`Proxying via relay ${RELAY_URL}/proxy`);
    const relayHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (RELAY_SECRET) relayHeaders["x-relay-secret"] = RELAY_SECRET;

    const relayRes = await fetch(`${RELAY_URL}/proxy`, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : undefined,
      }),
    });
    const result = await relayRes.json();
    return {
      ok: result.success ?? relayRes.ok,
      status: result.status ?? relayRes.status,
      data: result.data ?? result,
    };
  }

  // Last resort: direct fetch (will fail if geoblocked)
  console.log(`Direct fetch to ${url} (may be geoblocked)`);
  const res = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// ── Submit Order: sign locally, submit via proxy ──
async function signAndSubmitOrder(
  walletPrivateKey: string,
  proxyAddress: string | undefined,
  tokenId: string,
  side: "BUY" | "SELL",
  size: number,
  price: number,
  _negRisk = false,
  storedCreds?: { apiKey: string; secret: string; passphrase: string },
  marketName?: string,
): Promise<any> {
  if (!storedCreds) return { error: "API credentials required for local signing" };

  try {
    const { ethers } = await import("https://esm.sh/ethers@5.7.2");
    const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : `0x${walletPrivateKey}`;
    const wallet = new ethers.Wallet(pk);
    const funderAddress = proxyAddress || wallet.address;
    const sigType = proxyAddress ? 1 : 0; // 1 = POLY_PROXY (email/Magic login), 2 = Gnosis Safe

    const creds = {
      key: storedCreds.apiKey,
      secret: storedCreds.secret,
      passphrase: storedCreds.passphrase,
    };

    // Create ClobClient for local order signing
    const client = new ClobClient(CLOB_HOST, 137, wallet as any, creds, sigType, funderAddress);

    // Fetch tick size, fee rate, and negRisk via multiple sources
    let tickSize = 0.01;
    let feeRateBps = 0;
    let negRisk = _negRisk;

    // 1. Try Gamma API first for negRisk (not geoblocked) — also pass market name for pattern matching
    const gammaNegRisk = await fetchNegRiskFromGamma(tokenId, marketName);
    if (gammaNegRisk !== null) {
      negRisk = gammaNegRisk;
      console.log(`negRisk from Gamma API: ${negRisk}`);
    } else {
      // Gamma returned null (market not found) — default to false
      console.log(`Gamma returned null, defaulting negRisk=false`);
    }

    // 2. Fetch tick size and fee rate via proxy, and CLOB negRisk as fallback
    try {
      const [tickRes, feeRes, negRiskRes] = await Promise.all([
        proxiedFetch(`${CLOB_HOST}/tick-size?token_id=${tokenId}`, { method: "GET", headers: {} }),
        proxiedFetch(`${CLOB_HOST}/fee-rate?token_id=${tokenId}`, { method: "GET", headers: {} }),
        gammaNegRisk === null
          ? proxiedFetch(`${CLOB_HOST}/neg-risk?token_id=${tokenId}`, { method: "GET", headers: {} })
          : Promise.resolve({ ok: false, status: 0, data: {} }),
      ]);
      if (tickRes.ok && tickRes.data?.minimum_tick_size) {
        tickSize = parseFloat(tickRes.data.minimum_tick_size);
      }
      if (feeRes.ok && feeRes.data?.base_fee !== undefined) {
        feeRateBps = feeRes.data.base_fee;
      }
      if (gammaNegRisk === null && negRiskRes.ok && negRiskRes.data?.neg_risk !== undefined) {
        negRisk = negRiskRes.data.neg_risk;
      }
    } catch (e) {
      console.log("Market params lookup failed, using defaults");
    }

    console.log(`Market params: tickSize=${tickSize}, feeRateBps=${feeRateBps}, negRisk=${negRisk}`);

    // Round price to tick
    const tickedPrice = Math.round(price / tickSize) * tickSize;
    const finalPrice = Math.max(tickSize, Math.min(1 - tickSize, tickedPrice));
    const tradeSide = side === "BUY" ? ClobSide.BUY : ClobSide.SELL;

    console.log(`Signing order: ${side} $${size} @ $${finalPrice} (tick=${tickSize}, fee=${feeRateBps}, negRisk=${negRisk})`);

    // Strategy A: Try using SDK's createAndPostOrder directly (handles serialization correctly)
    try {
      console.log("Attempting SDK createAndPostOrder (direct)...");
      const sdkResult = await client.createAndPostOrder(
        { tokenID: tokenId, price: finalPrice, size, side: tradeSide, feeRateBps },
        { tickSize: `${tickSize}`, negRisk },
        OrderType.FAK,
      );
      console.log("SDK postOrder result:", JSON.stringify(sdkResult).substring(0, 300));
      if (sdkResult?.orderID || sdkResult?.success) {
        return { submitted: true, result: sdkResult, finalPrice, tickSize: `${tickSize}`, via: "sdk-direct" };
      }
      // If we get here, SDK call succeeded but no orderID — fall through to manual
      console.log("SDK returned no orderID, trying manual submission...");
    } catch (sdkErr: any) {
      console.log(`SDK direct failed: ${sdkErr.message?.substring(0, 200)} — falling back to manual proxy submission`);
    }

    // Strategy B: Sign with SDK, submit manually via proxy
    const signedOrder = await client.createOrder(
      { tokenID: tokenId, price: finalPrice, size, side: tradeSide, orderType: OrderType.FAK, feeRateBps },
      { tickSize: `${tickSize}`, negRisk },
    );

    console.log("Signed order fields:", JSON.stringify({
      salt: signedOrder.salt, saltType: typeof signedOrder.salt,
      makerAmount: signedOrder.makerAmount, makerAmountType: typeof signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount, takerAmountType: typeof signedOrder.takerAmount,
      side: signedOrder.side, sideType: typeof signedOrder.side,
      feeRateBps: signedOrder.feeRateBps, feeType: typeof signedOrder.feeRateBps,
      signatureType: signedOrder.signatureType, sigTypeType: typeof signedOrder.signatureType,
      nonce: signedOrder.nonce, nonceType: typeof signedOrder.nonce,
      expiration: signedOrder.expiration, expType: typeof signedOrder.expiration,
    }));

    // Use SDK's postOrder method (handles serialization correctly)
    try {
      console.log("Trying SDK postOrder with signed order...");
      const postResult = await client.postOrder(signedOrder, OrderType.FAK);
      console.log("SDK postOrder result:", JSON.stringify(postResult).substring(0, 300));
      if (postResult?.orderID || postResult?.success) {
        return { submitted: true, result: postResult, finalPrice, tickSize: `${tickSize}`, via: "sdk-postOrder" };
      }
    } catch (postErr: any) {
      console.log(`SDK postOrder failed: ${postErr.message?.substring(0, 200)}`);
    }

    // Strategy C: Manual proxy submission as last resort
    const sideStr = signedOrder.side === 0 || signedOrder.side === "BUY" ? "BUY" : "SELL";
    const orderPayload = {
      deferExec: false,
      order: {
        salt: Number.parseInt(String(signedOrder.salt), 10),
        maker: signedOrder.maker,
        signer: signedOrder.signer,
        taker: signedOrder.taker,
        tokenId: signedOrder.tokenId,
        makerAmount: signedOrder.makerAmount,
        takerAmount: signedOrder.takerAmount,
        side: sideStr,
        expiration: signedOrder.expiration,
        nonce: signedOrder.nonce,
        feeRateBps: signedOrder.feeRateBps,
        signatureType: signedOrder.signatureType,
        signature: signedOrder.signature,
      },
      owner: storedCreds.apiKey,
      orderType: "FAK",
    };

    console.log("Order payload owner:", orderPayload.owner, "maker:", orderPayload.order.maker, "signer:", orderPayload.order.signer);

    const ts = Math.floor(Date.now() / 1000);
    const orderBody = JSON.stringify(orderPayload);
    const l2Sig = await buildPolyHmacSignature(storedCreds.secret, ts, "POST", "/order", orderBody);
    const polyHeaders: Record<string, string> = {
      POLY_ADDRESS: wallet.address,
      POLY_SIGNATURE: l2Sig,
      POLY_TIMESTAMP: `${ts}`,
      POLY_API_KEY: storedCreds.apiKey,
      POLY_PASSPHRASE: storedCreds.passphrase,
      "Content-Type": "application/json",
    };

    console.log("Submitting order via proxy:", orderBody.substring(0, 300));

    const result = await proxiedFetch(`${CLOB_HOST}/order`, {
      method: "POST",
      headers: polyHeaders,
      body: orderBody,
    });

    console.log(`Order result [${result.status}]:`, JSON.stringify(result.data).substring(0, 300));

    if (result.ok && (result.data?.orderID || result.data?.success)) {
      return { submitted: true, result: result.data, finalPrice, tickSize: `${tickSize}`, via: "local-sign-proxy-submit" };
    } else {
      return { submitted: false, error: result.data?.error || result.data?.message || `Order rejected (${result.status})`, finalPrice, result: result.data };
    }
  } catch (e) {
    console.error("signAndSubmitOrder error:", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── L2-authenticated API calls ──
async function getOpenOrders(apiKey: string, secret: string, passphrase: string, walletAddress?: string): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const headers = await getL2Headers(apiKey, secret, passphrase, ts, "GET", "/data/orders", undefined, walletAddress);
  const res = await fetch(`${CLOB_HOST}/data/orders`, {
    method: "GET",
    headers: { ...headers, "Content-Type": "application/json" },
  });
  return res.ok ? await res.json() : { error: await res.text(), status: res.status };
}

async function getTradeHistory(
  apiKey: string,
  secret: string,
  passphrase: string,
  walletAddress?: string,
): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const headers = await getL2Headers(apiKey, secret, passphrase, ts, "GET", "/data/trades", undefined, walletAddress);
  const res = await fetch(`${CLOB_HOST}/data/trades`, {
    method: "GET",
    headers: { ...headers, "Content-Type": "application/json" },
  });
  return res.ok ? await res.json() : { error: await res.text(), status: res.status };
}

// ── Credential Verification (L1 EIP-712) ──
async function verifyViaL1(walletKey: string): Promise<{ ok: boolean; status: number; body: string }> {
  const { ethers } = await import("https://esm.sh/ethers@5.7.2");
  const pk = walletKey.startsWith("0x") ? walletKey : `0x${walletKey}`;
  const wallet = new ethers.Wallet(pk);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet._signTypedData(
    { name: "ClobAuthDomain", version: "1", chainId: 137 },
    {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    {
      address: wallet.address,
      timestamp: `${ts}`,
      nonce: 0,
      message: "This message attests that I control the given wallet",
    },
  );
  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: "GET",
    headers: {
      POLY_ADDRESS: wallet.address,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: `${ts}`,
      POLY_NONCE: "0",
      "Content-Type": "application/json",
    },
  });
  const body = await res.text();
  console.log(`L1 verify [${res.status}]:`, body);
  return { ok: res.ok, status: res.status, body };
}

// ── Get Polymarket CLOB USDC Balance ──
async function getClobBalance(
  apiKey: string,
  secret: string,
  passphrase: string,
  walletAddress: string,
): Promise<number> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const headers = await getL2Headers(
      apiKey,
      secret,
      passphrase,
      ts,
      "GET",
      "/balance-allowance",
      undefined,
      walletAddress,
    );
    const res = await fetch(`${CLOB_HOST}/balance-allowance?asset_type=COLLATERAL&signature_type=1`, {
      method: "GET",
      headers: { ...headers, "Content-Type": "application/json" },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const raw = parseFloat(data.balance || "0");
    console.log(`CLOB balance: ${raw}`);
    return raw > 1000 ? raw / 1e6 : raw;
  } catch (e) {
    console.error("CLOB balance error:", e);
    return 0;
  }
}

// ── Main Handler ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const POLY_API_KEY = Deno.env.get("POLYMARKET_API_KEY");
    let POLY_SECRET = Deno.env.get("POLYMARKET_API_SECRET");
    const POLY_PASSPHRASE = Deno.env.get("POLYMARKET_PASSPHRASE");
    if (POLY_SECRET && POLY_SECRET.length % 4 !== 0) {
      POLY_SECRET += "=".repeat(4 - (POLY_SECRET.length % 4));
    }
    console.log("Auth:", POLY_SECRET?.length, "apiKey:", POLY_API_KEY?.substring(0, 8));

    const POLY_WALLET_KEY = Deno.env.get("POLYMARKET_WALLET_PRIVATE_KEY");
    const POLY_PROXY_ADDRESS = Deno.env.get("POLYMARKET_PROXY_ADDRESS");

    // Derive EOA address
    let eoaAddress = "";
    if (POLY_WALLET_KEY) {
      try {
        const { ethers } = await import("https://esm.sh/ethers@5.7.2");
        const wallet = new ethers.Wallet(POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`);
        eoaAddress = wallet.address.toLowerCase();
      } catch (e) {
        console.error("Wallet derive error:", e);
      }
    }

    const clobAuthAddress = eoaAddress;
    const proxyAddress = POLY_PROXY_ADDRESS?.toLowerCase() || eoaAddress;

    const { action, ...params } = await req.json();
    const json = (data: any, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    switch (action) {
      case "get-prices": {
        const prices: Record<string, any> = {};
        for (const tid of params.tokenIds || []) prices[tid] = await getMidpoint(tid);
        return json({ prices });
      }

      case "get-orderbook":
        return json((await getOrderbook(params.tokenId)) || { error: "Not found" });

      case "search-markets":
        return json({ markets: await searchMarkets(params.query || "") });

      case "get-market-tokens":
        return json((await getMarketTokens(params.conditionId)) || { error: "Not found" });

      case "get-positions":
        if (!proxyAddress) return json({ error: "Wallet not configured" }, 400);
        return json(await getPositions(proxyAddress));

      case "verify-connection": {
        const connected = !!(POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE && clobAuthAddress);
        let verified = false,
          verifyDebug: any = null;
        let polymarketUsdc = 0,
          positionsValue = 0;
        let eoaBal = { usdc: 0, matic: 0 },
          proxyBal = { usdc: 0, matic: 0 };

        if (connected) {
          // Verify via L1 + fetch balances in parallel
          const tasks: Promise<any>[] = [
            POLY_WALLET_KEY ? verifyViaL1(POLY_WALLET_KEY) : Promise.resolve({ ok: false }),
            getWalletBalance(eoaAddress),
            proxyAddress !== eoaAddress ? getWalletBalance(proxyAddress) : Promise.resolve({ usdc: 0, matic: 0 }),
            proxyAddress ? getPositions(proxyAddress) : Promise.resolve([]),
            getClobBalance(POLY_API_KEY!, POLY_SECRET!, POLY_PASSPHRASE!, clobAuthAddress),
          ];
          const [l1Result, eoa, proxy, posData, clobBal] = await Promise.all(tasks);
          verified = l1Result.ok;
          verifyDebug = { status: l1Result.status, body: l1Result.body };
          eoaBal = eoa;
          proxyBal = proxy;
          polymarketUsdc = clobBal;
          if (Array.isArray(posData)) posData.forEach((p: any) => (positionsValue += p.currentValue || 0));
        }

        const totalUsdc = eoaBal.usdc + proxyBal.usdc + polymarketUsdc;
        return json({
          connected,
          verified,
          walletAddress: proxyAddress || null,
          eoaAddress: eoaAddress || null,
          verifyDebug,
          balance: {
            usdc: totalUsdc,
            matic: eoaBal.matic + proxyBal.matic,
            eoaUsdc: eoaBal.usdc,
            proxyUsdc: proxyBal.usdc,
            polymarketUsdc,
            positionsValue,
            total: totalUsdc + positionsValue,
          },
        });
      }

      case "get-wallet-balance": {
        if (!clobAuthAddress) return json({ error: "Wallet not configured" }, 400);
        const [eoa, proxy, posData] = await Promise.all([
          getWalletBalance(eoaAddress),
          proxyAddress !== eoaAddress ? getWalletBalance(proxyAddress) : Promise.resolve({ usdc: 0, matic: 0 }),
          proxyAddress ? getPositions(proxyAddress) : Promise.resolve([]),
        ]);
        let posValue = 0;
        if (Array.isArray(posData)) posData.forEach((p: any) => (posValue += p.currentValue || 0));
        let pmUsdc = 0;
        if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE) {
          pmUsdc = await getClobBalance(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        }
        const total = eoa.usdc + proxy.usdc + pmUsdc;
        return json({
          usdc: total,
          matic: eoa.matic + proxy.matic,
          eoaUsdc: eoa.usdc,
          proxyUsdc: proxy.usdc,
          polymarketUsdc: pmUsdc,
          positionsValue: posValue,
          total: total + posValue,
        });
      }

      case "get-open-orders":
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) return json({ error: "API creds missing" }, 400);
        return json(await getOpenOrders(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress));

      case "get-trades":
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) return json({ error: "API creds missing" }, 400);
        return json(await getTradeHistory(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress));

      case "sign-order":
      case "place-trade": {
        if (!POLY_WALLET_KEY) return json({ error: "Wallet private key not configured" }, 400);
        const { tokenId, side, size, price, negRisk, market } = params;
        if (!tokenId || !side || !size || !price) return json({ error: "Missing: tokenId, side, size, price" }, 400);

        // Default negRisk=true for crypto up/down markets if not explicitly set
        let resolvedNegRisk = negRisk;
        if (resolvedNegRisk === undefined || resolvedNegRisk === null) {
          resolvedNegRisk = false; // Default to false — Gamma API will resolve the actual value in signAndSubmitOrder
          console.log(`negRisk not specified, defaulting to false (will be resolved by Gamma API)`);
        }

        // Strategy 1: Use relay server's /trade endpoint (it signs + submits from non-blocked region)
        let RELAY_URL = Deno.env.get("RELAY_SERVER_URL") || "";
        if (RELAY_URL && !RELAY_URL.startsWith("http")) RELAY_URL = `https://${RELAY_URL}`;
        const RELAY_SECRET_VAL = Deno.env.get("RELAY_SECRET") || "";

        if (RELAY_URL) {
          console.log(`Routing trade via relay ${RELAY_URL}/trade`);
          const relayHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (RELAY_SECRET_VAL) relayHeaders["x-relay-secret"] = RELAY_SECRET_VAL;

          try {
            const relayRes = await fetch(`${RELAY_URL}/trade`, {
              method: "POST",
              headers: relayHeaders,
              body: JSON.stringify({ tokenId, side, amount: size, price, orderType: "FAK" }),
            });
            const relayResult = await relayRes.json();
            console.log(`Relay /trade response [${relayRes.status}]:`, JSON.stringify(relayResult).substring(0, 300));

            if (relayResult.success) {
              return json({
                submitted: true,
                result: relayResult.data || relayResult,
                finalPrice: relayResult.finalPrice || price,
                tickSize: relayResult.tickSize || "0.01",
                via: "relay-trade",
              });
            } else {
              console.log("Relay /trade failed, falling back to local sign + proxy submit");
            }
          } catch (e) {
            console.error("Relay /trade error:", e);
          }
        }

        // Strategy 2: Sign locally, submit via proxy
        const storedCreds =
          POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE
            ? { apiKey: POLY_API_KEY, secret: POLY_SECRET, passphrase: POLY_PASSPHRASE }
            : undefined;
        const result = await signAndSubmitOrder(
          POLY_WALLET_KEY,
          POLY_PROXY_ADDRESS || undefined,
          tokenId,
          side,
          size,
          price,
          resolvedNegRisk,
          storedCreds,
          market,
        );
        return json(result, result.error ? 400 : 200);
      }

      case "derive-api-key": {
        if (!POLY_WALLET_KEY) return json({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }, 400);
        try {
          const { ethers } = await import("https://esm.sh/ethers@5.7.2");
          const pk = POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`;
          const wallet = new ethers.Wallet(pk);
          const proxyAddr = POLY_PROXY_ADDRESS || wallet.address;
          const useProxy = params.useProxy ?? false;
          const authAddress = useProxy ? proxyAddr : wallet.address;
          const ts = Math.floor(Date.now() / 1000);
          const nonce = params.nonce ?? 0;
          const sig = await wallet._signTypedData(
            { name: "ClobAuthDomain", version: "1", chainId: 137 },
            {
              ClobAuth: [
                { name: "address", type: "address" },
                { name: "timestamp", type: "string" },
                { name: "nonce", type: "uint256" },
                { name: "message", type: "string" },
              ],
            },
            {
              address: authAddress,
              timestamp: `${ts}`,
              nonce,
              message: "This message attests that I control the given wallet",
            },
          );
          const l1Headers = {
            POLY_ADDRESS: authAddress,
            POLY_SIGNATURE: sig,
            POLY_TIMESTAMP: `${ts}`,
            POLY_NONCE: `${nonce}`,
          };
          let res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
            method: "GET",
            headers: { ...l1Headers, "Content-Type": "application/json" },
          });
          let result;
          if (res.ok) {
            result = await res.json();
          } else {
            const deriveErr = await res.text();
            res = await fetch(`${CLOB_HOST}/auth/api-key`, {
              method: "POST",
              headers: { ...l1Headers, "Content-Type": "application/json" },
            });
            if (!res.ok) return json({ error: `Derive+Create failed: ${deriveErr}. ${await res.text()}` }, 400);
            result = await res.json();
          }
          return json({
            authAddress,
            eoaAddress: wallet.address,
            proxyAddress: proxyAddr,
            apiKey: result.apiKey,
            secret: result.secret,
            passphrase: result.passphrase,
          });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
        }
      }

      case "test-proxy": {
        const results: any[] = [];
        let RELAY_URL = Deno.env.get("RELAY_SERVER_URL") || "https://polymarket-kit-production.up.railway.app";
        if (RELAY_URL && !RELAY_URL.startsWith("http")) RELAY_URL = `https://${RELAY_URL}`;

        // Test relay health
        try {
          const r = await fetch(`${RELAY_URL}/health`);
          const b = await r.text();
          results.push({ test: "relay health", status: r.status, body: b.substring(0, 300) });
        } catch (e) {
          results.push({ test: "relay health", error: String(e) });
        }

        // Test direct POST /order (check if geoblocked)
        if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE) {
          try {
            const ts = Math.floor(Date.now() / 1000);
            const h = await getL2Headers(
              POLY_API_KEY,
              POLY_SECRET,
              POLY_PASSPHRASE,
              ts,
              "POST",
              "/order",
              "{}",
              clobAuthAddress,
            );
            const r = await fetch(`${CLOB_HOST}/order`, {
              method: "POST",
              headers: { ...h, "Content-Type": "application/json" },
              body: "{}",
            });
            const b = await r.text();
            results.push({ test: "direct POST /order", status: r.status, body: b.substring(0, 300) });
          } catch (e) {
            results.push({ test: "direct POST /order", error: String(e) });
          }
        }

        return json({ results });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("polymarket-trade error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
