import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildPolyHmacSignature } from "https://esm.sh/@polymarket/clob-client@5.2.3/dist/signing/hmac";
import { ClobClient } from "https://esm.sh/@polymarket/clob-client@5.2.3";
import { Side as ClobSide, OrderType } from "https://esm.sh/@polymarket/clob-client@5.2.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CLOB_HOST = "https://clob.polymarket.com";

// ── Bright Data Web Unlocker ──
async function fetchViaProxy(targetUrl: string, options: RequestInit): Promise<Response> {
  const apiKey = Deno.env.get("BRIGHTDATA_API_KEY");
  if (!apiKey) throw new Error("BRIGHTDATA_API_KEY not configured");

  const method = options.method || "GET";
  const body = options.body
    ? typeof options.body === "string" ? options.body : JSON.stringify(options.body)
    : undefined;

  const forwardHeaders: Record<string, string> = {};
  const hdrs = new Headers(options.headers as HeadersInit);
  hdrs.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower !== "host" && lower !== "connection") forwardHeaders[k] = v;
  });

  const requestBody: any = { zone: "web_unlocker1", url: targetUrl, method, format: "raw" };
  if (Object.keys(forwardHeaders).length > 0) requestBody.headers = forwardHeaders;
  if (body) requestBody.body = body;

  console.log(`WebUnlocker: ${method} ${targetUrl}`);
  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  });

  const responseBody = await res.text();
  console.log(`WebUnlocker [${res.status}]: ${responseBody.substring(0, 300)}`);
  return new Response(responseBody, { status: res.status, headers: { "Content-Type": "application/json" } });
}

// ── L2 HMAC Auth Headers ──
async function getL2Headers(
  apiKey: string, secret: string, passphrase: string, timestamp: number,
  method: string, requestPath: string, body?: string, walletAddress?: string,
) {
  const sig = await buildPolyHmacSignature(secret, timestamp, method, requestPath, body);
  console.log("L2 HMAC:", JSON.stringify({
    sig: sig?.substring(0, 20), method, requestPath: requestPath?.substring(0, 40),
    apiKey: apiKey?.substring(0, 8), addr: walletAddress?.substring(0, 10),
  }));
  return {
    POLY_ADDRESS: walletAddress || apiKey,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
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
  const res = await fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10&query=${encodeURIComponent(query)}`);
  return res.ok ? await res.json() : [];
}

async function getPositions(walletAddress: string): Promise<any> {
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${walletAddress}`);
  if (!res.ok) { console.error("Positions error:", res.status); return { error: await res.text() }; }
  return await res.json();
}

// ── Wallet Balance (Polygon RPC) ──
async function getWalletBalance(walletAddress: string): Promise<{ usdc: number; matic: number }> {
  const RPC = "https://polygon-rpc.com";
  const USDC_ADDRS = [
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  ];

  let totalUsdc = 0;
  for (const usdcAddr of USDC_ADDRS) {
    try {
      const padded = walletAddress.replace("0x", "").padStart(64, "0");
      const res = await fetch(RPC, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: usdcAddr, data: `0x70a08231000000000000000000000000${padded}` }, "latest"], id: 1 }),
      });
      const data = await res.json();
      if (data.result && data.result !== "0x") totalUsdc += parseInt(data.result, 16) / 1e6;
    } catch (e) { console.error(`USDC balance error (${usdcAddr}):`, e); }
  }

  let matic = 0;
  try {
    const res = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [walletAddress, "latest"], id: 2 }),
    });
    const data = await res.json();
    if (data.result) matic = parseInt(data.result, 16) / 1e18;
  } catch {}

  return { usdc: totalUsdc, matic };
}

// ── Sign & Submit Order (via Web Unlocker) ──
async function signAndSubmitOrder(
  walletPrivateKey: string, proxyAddress: string | undefined,
  tokenId: string, side: "BUY" | "SELL", size: number, price: number, negRisk = false,
  storedCreds?: { apiKey: string; secret: string; passphrase: string },
): Promise<any> {
  const { ethers } = await import("https://esm.sh/ethers@5.7.2");
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : `0x${walletPrivateKey}`;
  const wallet = new ethers.Wallet(pk);
  const sigType = 1; // POLY_PROXY
  const funderAddress = proxyAddress || wallet.address;

  console.log(`Signing: sigType=${sigType}, funder=${funderAddress?.substring(0, 10)}, eoa=${wallet.address.substring(0, 10)}`);

  try {
    // Step 1: Use stored credentials if available, otherwise derive
    let creds: any;
    if (storedCreds?.apiKey && storedCreds?.secret && storedCreds?.passphrase) {
      creds = { apiKey: storedCreds.apiKey, secret: storedCreds.secret, passphrase: storedCreds.passphrase };
      console.log("Using stored L2 creds:", creds.apiKey?.substring(0, 8));
    } else {
      const initClient = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, sigType, funderAddress);
      try {
        creds = await initClient.deriveApiKey();
        console.log("Derived L2 creds:", creds.apiKey?.substring(0, 8));
      } catch (e1) {
        try { creds = await initClient.createOrDeriveApiKey(); } catch (e2) {
          return { error: `L2_AUTH_FAILED: ${e2 instanceof Error ? e2.message : String(e2)}` };
        }
      }
    }

    // Step 2: Create authenticated client
    const authedClient = new ClobClient("https://clob.polymarket.com", 137, wallet,
      { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase }, sigType, funderAddress);

    // Step 3: Determine tick size
    let tickSize = "0.01";
    try {
      const book = await getOrderbook(tokenId);
      if (book?.market?.minimum_tick_size) tickSize = book.market.minimum_tick_size;
    } catch {}

    const tick = parseFloat(tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    const finalPrice = Math.max(tick, Math.min(1 - tick, roundedPrice));

    console.log(`Order: token=${tokenId.substring(0, 20)}…, ${side}, sz=${size}, px=${finalPrice}, tick=${tickSize}`);

    // Step 4: Create signed order
    const signedOrder = await authedClient.createOrder(
      { tokenID: tokenId, price: finalPrice, size, side: side === "BUY" ? ClobSide.BUY : ClobSide.SELL, orderType: OrderType.FOK },
      { tickSize, negRisk },
    );

    console.log("Order signed, submitting to CLOB via US proxy…");

    // Step 5: Submit via US residential proxy to bypass geoblocking
    const timestamp = Math.floor(Date.now() / 1000);
    const orderBody = JSON.stringify(signedOrder);
    const l2Headers = await getL2Headers(creds.apiKey, creds.secret, creds.passphrase, timestamp, "POST", "/order", orderBody, wallet.address);

    const usProxyUrl = Deno.env.get("US_PROXY_URL");
    const caCert = Deno.env.get("BRIGHTDATA_CA_CERT");
    let submitRes: Response;
    let submitBody: string;
    let via = "direct";

    if (usProxyUrl) {
      const proxyUrl = new URL(usProxyUrl);
      const username = decodeURIComponent(proxyUrl.username);
      const password = decodeURIComponent(proxyUrl.password);
      const baseHost = proxyUrl.hostname;

      // Fix CA cert format: the secret may have spaces instead of newlines
      let fixedCert: string | undefined;
      if (caCert) {
        // Reconstruct proper PEM format
        let certBody = caCert
          .replace(/-----BEGIN CERTIFICATE-----/g, "")
          .replace(/-----END CERTIFICATE-----/g, "")
          .replace(/\s+/g, "");
        // Split into 64-char lines
        const lines: string[] = [];
        for (let i = 0; i < certBody.length; i += 64) {
          lines.push(certBody.substring(i, i + 64));
        }
        fixedCert = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
        console.log("CA cert fixed, length:", fixedCert.length);
      }

      // Try port 33335 with SSL interception (CA cert required)
      let success = false;
      const ports = ["33335", "22225"];
      for (const port of ports) {
        try {
          const proxyHostUrl = `http://${baseHost}:${port}`;
          const clientOpts: any = {
            proxy: { url: proxyHostUrl, basicAuth: { username, password } },
          };
          if (port === "33335" && fixedCert) clientOpts.caCerts = [fixedCert];

          console.log(`Trying proxy ${baseHost}:${port}…`);
          const httpClient = Deno.createHttpClient(clientOpts);
          submitRes = await fetch(`${CLOB_HOST}/order`, {
            method: "POST",
            headers: { ...l2Headers, "Content-Type": "application/json" },
            body: orderBody,
            // @ts-ignore Deno-specific
            client: httpClient,
          });
          submitBody = await submitRes.text();
          via = `proxy-${port}`;
          console.log(`${via} [${submitRes.status}]: ${submitBody.substring(0, 500)}`);
          success = true;
          break;
        } catch (err) {
          console.error(`proxy-${port} failed: ${err}`);
        }
      }

      if (!success) {
        console.error("All proxy attempts failed");
        return { submitted: false, error: "All proxy attempts failed - geoblocked", signedOrder, finalPrice, tickSize };
      }
    } else {
      submitRes = await fetch(`${CLOB_HOST}/order`, {
        method: "POST",
        headers: { ...l2Headers, "Content-Type": "application/json" },
        body: orderBody,
      });
      submitBody = await submitRes.text();
      console.log(`Direct submit [${submitRes.status}]: ${submitBody.substring(0, 500)}`);
    }

    if (submitRes!.ok && submitBody!.trim()) {
      let result;
      try { result = JSON.parse(submitBody!); } catch { result = submitBody; }
      const orderId = result?.orderID || result?.order_id;
      if (orderId) {
        console.log(`✅ Order submitted → ID: ${orderId} (via ${via})`);
        return { submitted: true, result, finalPrice, tickSize, via };
      } else {
        console.error(`⚠ No orderID in response (via ${via}): ${submitBody!.substring(0, 300)}`);
        return { submitted: false, error: `No orderID: ${submitBody!.substring(0, 200)}`, signedOrder, finalPrice, tickSize };
      }
    } else {
      console.error(`Submit FAILED [${submitRes!.status}] (${via}): ${submitBody!.substring(0, 300)}`);
      return { submitted: false, error: `Polymarket ${submitRes!.status}: ${submitBody!.substring(0, 200)}`, signedOrder, finalPrice, tickSize };
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
  const res = await fetch(`${CLOB_HOST}/data/orders`, { method: "GET", headers: { ...headers, "Content-Type": "application/json" } });
  return res.ok ? await res.json() : { error: await res.text(), status: res.status };
}

async function getTradeHistory(apiKey: string, secret: string, passphrase: string, walletAddress?: string): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const headers = await getL2Headers(apiKey, secret, passphrase, ts, "GET", "/data/trades", undefined, walletAddress);
  const res = await fetch(`${CLOB_HOST}/data/trades`, { method: "GET", headers: { ...headers, "Content-Type": "application/json" } });
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
    { ClobAuth: [{ name: "address", type: "address" }, { name: "timestamp", type: "string" }, { name: "nonce", type: "uint256" }, { name: "message", type: "string" }] },
    { address: wallet.address, timestamp: `${ts}`, nonce: 0, message: "This message attests that I control the given wallet" },
  );
  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: "GET",
    headers: { POLY_ADDRESS: wallet.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: `${ts}`, POLY_NONCE: "0", "Content-Type": "application/json" },
  });
  const body = await res.text();
  console.log(`L1 verify [${res.status}]:`, body);
  return { ok: res.ok, status: res.status, body };
}

// ── Get Polymarket CLOB USDC Balance ──
async function getClobBalance(apiKey: string, secret: string, passphrase: string, walletAddress: string): Promise<number> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const headers = await getL2Headers(apiKey, secret, passphrase, ts, "GET", "/balance-allowance", undefined, walletAddress);
    const res = await fetch(`${CLOB_HOST}/balance-allowance?asset_type=COLLATERAL&signature_type=1`, {
      method: "GET", headers: { ...headers, "Content-Type": "application/json" },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const raw = parseFloat(data.balance || "0");
    console.log(`CLOB balance: ${raw}`);
    return raw > 1000 ? raw / 1e6 : raw;
  } catch (e) { console.error("CLOB balance error:", e); return 0; }
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
      } catch (e) { console.error("Wallet derive error:", e); }
    }

    const clobAuthAddress = eoaAddress;
    const proxyAddress = POLY_PROXY_ADDRESS?.toLowerCase() || eoaAddress;

    const { action, ...params } = await req.json();
    const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    switch (action) {
      case "get-prices": {
        const prices: Record<string, any> = {};
        for (const tid of params.tokenIds || []) prices[tid] = await getMidpoint(tid);
        return json({ prices });
      }

      case "get-orderbook":
        return json(await getOrderbook(params.tokenId) || { error: "Not found" });

      case "search-markets":
        return json({ markets: await searchMarkets(params.query || "") });

      case "get-market-tokens":
        return json(await getMarketTokens(params.conditionId) || { error: "Not found" });

      case "get-positions":
        if (!proxyAddress) return json({ error: "Wallet not configured" }, 400);
        return json(await getPositions(proxyAddress));

      case "verify-connection": {
        const connected = !!(POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE && clobAuthAddress);
        let verified = false, verifyDebug: any = null;
        let polymarketUsdc = 0, positionsValue = 0;
        let eoaBal = { usdc: 0, matic: 0 }, proxyBal = { usdc: 0, matic: 0 };

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
          eoaBal = eoa; proxyBal = proxy; polymarketUsdc = clobBal;
          if (Array.isArray(posData)) posData.forEach((p: any) => positionsValue += p.currentValue || 0);
        }

        const totalUsdc = eoaBal.usdc + proxyBal.usdc + polymarketUsdc;
        return json({
          connected, verified, walletAddress: proxyAddress || null, eoaAddress: eoaAddress || null, verifyDebug,
          balance: { usdc: totalUsdc, matic: eoaBal.matic + proxyBal.matic, eoaUsdc: eoaBal.usdc, proxyUsdc: proxyBal.usdc, polymarketUsdc, positionsValue, total: totalUsdc + positionsValue },
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
        if (Array.isArray(posData)) posData.forEach((p: any) => posValue += p.currentValue || 0);
        let pmUsdc = 0;
        if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE) {
          pmUsdc = await getClobBalance(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        }
        const total = eoa.usdc + proxy.usdc + pmUsdc;
        return json({ usdc: total, matic: eoa.matic + proxy.matic, eoaUsdc: eoa.usdc, proxyUsdc: proxy.usdc, polymarketUsdc: pmUsdc, positionsValue: posValue, total: total + posValue });
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
        const { tokenId, side, size, price, negRisk } = params;
        if (!tokenId || !side || !size || !price) return json({ error: "Missing: tokenId, side, size, price" }, 400);
        const storedCreds = (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE)
          ? { apiKey: POLY_API_KEY, secret: POLY_SECRET, passphrase: POLY_PASSPHRASE } : undefined;
        const result = await signAndSubmitOrder(POLY_WALLET_KEY, POLY_PROXY_ADDRESS || undefined, tokenId, side, size, price, negRisk || false, storedCreds);
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
            { ClobAuth: [{ name: "address", type: "address" }, { name: "timestamp", type: "string" }, { name: "nonce", type: "uint256" }, { name: "message", type: "string" }] },
            { address: authAddress, timestamp: `${ts}`, nonce, message: "This message attests that I control the given wallet" },
          );
          const l1Headers = { POLY_ADDRESS: authAddress, POLY_SIGNATURE: sig, POLY_TIMESTAMP: `${ts}`, POLY_NONCE: `${nonce}` };
          let res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, { method: "GET", headers: { ...l1Headers, "Content-Type": "application/json" } });
          let result;
          if (res.ok) { result = await res.json(); } else {
            const deriveErr = await res.text();
            res = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "POST", headers: { ...l1Headers, "Content-Type": "application/json" } });
            if (!res.ok) return json({ error: `Derive+Create failed: ${deriveErr}. ${await res.text()}` }, 400);
            result = await res.json();
          }
          return json({ authAddress, eoaAddress: wallet.address, proxyAddress: proxyAddr, apiKey: result.apiKey, secret: result.secret, passphrase: result.passphrase });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500); }
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("polymarket-trade error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
