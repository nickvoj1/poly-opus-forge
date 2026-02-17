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

// Bright Data CA certificate loaded from secret (port 33335)
function getBrightDataCACerts(): string[] {
  const raw = Deno.env.get("BRIGHTDATA_CA_CERT");
  if (!raw) {
    console.warn("BRIGHTDATA_CA_CERT secret not set, TLS may fail");
    return [];
  }
  // Normalize: secret may have spaces instead of newlines
  // Extract base64 body, split into 64-char lines, reconstruct proper PEM
  const stripped = raw.replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const lines = stripped.match(/.{1,64}/g) || [];
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
  return [pem];
}

// Fetch via Bright Data proxy using multiple methods
// Try: 1) SOCKS5 on port 22225, 2) Manual CONNECT tunnel on port 33335 with CA cert
async function fetchViaProxy(
  proxyUrl: string,
  targetUrl: string,
  options: RequestInit,
): Promise<Response> {
  const proxyParsed = new URL(proxyUrl);
  const proxyHost = proxyParsed.hostname;
  const proxyUser = decodeURIComponent(proxyParsed.username);
  const proxyPass = decodeURIComponent(proxyParsed.password);
  
  // Method 1: Try SOCKS5 (Bright Data supports SOCKS5 on port 22225)
  const socks5Url = `socks5://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@${proxyHost}:22225`;
  console.log(`Trying SOCKS5 proxy → ${targetUrl}`);
  
  try {
    const httpClient = Deno.createHttpClient({
      proxy: { url: socks5Url },
    });
    const res = await fetch(targetUrl, {
      ...options,
      // @ts-ignore - Deno-specific
      client: httpClient,
    });
    console.log(`SOCKS5 succeeded: ${res.status}`);
    // Clone and close client
    const body = await res.text();
    try { httpClient.close(); } catch {}
    return new Response(body, { status: res.status, headers: res.headers });
  } catch (e1) {
    console.warn(`SOCKS5 failed: ${e1}`);
  }

  // Method 2: Try HTTP CONNECT proxy (standard tunnel)
  const httpProxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@${proxyHost}:22225`;
  console.log(`Trying HTTP proxy → ${targetUrl}`);
  
  try {
    const httpClient = Deno.createHttpClient({
      proxy: { url: httpProxyUrl },
    });
    const res = await fetch(targetUrl, {
      ...options,
      // @ts-ignore - Deno-specific
      client: httpClient,
    });
    console.log(`HTTP proxy succeeded: ${res.status}`);
    const body = await res.text();
    try { httpClient.close(); } catch {}
    return new Response(body, { status: res.status, headers: res.headers });
  } catch (e2) {
    console.warn(`HTTP proxy failed: ${e2}`);
  }

  // Method 3: Manual CONNECT tunnel on port 33335 with CA cert
  console.log(`Trying manual CONNECT tunnel → ${targetUrl}`);
  const targetParsed = new URL(targetUrl);
  const targetHost = targetParsed.hostname;
  const targetPort = parseInt(targetParsed.port || "443");
  const caCerts = getBrightDataCACerts();
  
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  const tcpConn = await Deno.connect({ hostname: proxyHost, port: 33335 });
  const authB64 = btoa(`${proxyUser}:${proxyPass}`);
  const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Authorization: Basic ${authB64}\r\n\r\n`;
  await tcpConn.write(encoder.encode(connectReq));
  
  const buf = new Uint8Array(4096);
  const n = await tcpConn.read(buf);
  if (n === null) { tcpConn.close(); throw new Error("Proxy closed connection"); }
  const connectResponse = decoder.decode(buf.subarray(0, n));
  console.log(`CONNECT response: ${connectResponse.trim().split('\r\n')[0]}`);
  if (!connectResponse.includes("200")) { tcpConn.close(); throw new Error(`CONNECT failed: ${connectResponse.trim().split('\r\n')[0]}`); }
  
  const tlsOpts: any = { hostname: targetHost };
  if (caCerts.length > 0) tlsOpts.caCerts = caCerts;
  const tlsConn = await Deno.startTls(tcpConn, tlsOpts);
  
  const method = options.method || "GET";
  const path = targetParsed.pathname + targetParsed.search;
  const hdrs = new Headers(options.headers as HeadersInit);
  hdrs.set("Host", targetHost);
  if (!hdrs.has("Content-Type")) hdrs.set("Content-Type", "application/json");
  hdrs.set("Connection", "close");
  
  let httpReq = `${method} ${path} HTTP/1.1\r\n`;
  hdrs.forEach((v, k) => { httpReq += `${k}: ${v}\r\n`; });
  
  const bodyStr = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : "";
  if (bodyStr) httpReq += `Content-Length: ${encoder.encode(bodyStr).length}\r\n`;
  httpReq += `\r\n`;
  if (bodyStr) httpReq += bodyStr;
  
  await tlsConn.write(encoder.encode(httpReq));
  
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = new Uint8Array(8192);
      const bytesRead = await tlsConn.read(chunk);
      if (bytesRead === null) break;
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } catch (readErr) {
    if (chunks.length === 0) throw readErr;
  }
  try { tlsConn.close(); } catch {}
  
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const fullBuf = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { fullBuf.set(c, offset); offset += c.length; }
  
  const fullResponse = decoder.decode(fullBuf);
  const headerEnd = fullResponse.indexOf("\r\n\r\n");
  const statusLine = fullResponse.split("\r\n")[0];
  const statusMatch = statusLine.match(/HTTP\/\d\.?\d?\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 500;
  
  const headersSection = fullResponse.substring(0, headerEnd);
  let responseBody: string;
  if (headersSection.toLowerCase().includes("transfer-encoding: chunked")) {
    responseBody = parseChunkedBody(fullResponse.substring(headerEnd + 4));
  } else {
    responseBody = fullResponse.substring(headerEnd + 4);
  }
  
  console.log(`Manual tunnel response: ${status} (${responseBody.length} chars)`);
  return new Response(responseBody, { status, headers: { "Content-Type": "application/json" } });
}

// Parse HTTP chunked transfer encoding
function parseChunkedBody(raw: string): string {
  let result = "";
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const sizeHex = raw.substring(pos, lineEnd).trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    result += raw.substring(chunkStart, chunkStart + size);
    pos = chunkStart + size + 2; // skip chunk data + \r\n
  }
  return result;
}


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
    "L2 HMAC debug:",
    JSON.stringify({
      sig: sig?.substring(0, 20),
      sigType: typeof sig,
      secretLen: secret?.length,
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

// Get current orderbook prices for a token
async function getPrice(tokenId: string): Promise<any> {
  const res = await fetch(`${CLOB_HOST}/price?token_id=${tokenId}&side=buy`);
  if (!res.ok) {
    const buyErr = await res.text();
    console.error("Price fetch error:", buyErr);
    return null;
  }
  const buyPrice = await res.json();

  const sellRes = await fetch(`${CLOB_HOST}/price?token_id=${tokenId}&side=sell`);
  const sellPrice = sellRes.ok ? await sellRes.json() : null;

  return { buy: buyPrice, sell: sellPrice };
}

// Get orderbook for a token
async function getOrderbook(tokenId: string): Promise<any> {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  if (!res.ok) return null;
  return await res.json();
}

// Get midpoint price
async function getMidpoint(tokenId: string): Promise<string | null> {
  const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.mid;
}

// Fetch market by condition_id from Gamma API to get token IDs
async function getMarketTokens(conditionId: string): Promise<any> {
  const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
  if (!res.ok) return null;
  const markets = await res.json();
  return markets[0] || null;
}

// Search markets by slug or question
async function searchMarkets(query: string): Promise<any[]> {
  const res = await fetch(
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10&query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return [];
  return await res.json();
}

// Get user positions from Data API (public, requires wallet address)
async function getPositions(walletAddress: string): Promise<any> {
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${walletAddress}`);

  if (!res.ok) {
    const errText = await res.text();
    console.error("Positions fetch error:", res.status, errText);
    return { error: errText, status: res.status };
  }

  return await res.json();
}

// Derive wallet address from private key using basic secp256k1
// We use the CLOB API's /auth/api-keys endpoint to verify credentials
async function verifyCredentials(
  apiKey: string,
  secret: string,
  passphrase: string,
  walletAddress: string,
): Promise<{ ok: boolean; status: number; body: string; headers: Record<string, string> }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const path = "/auth/api-keys";

  const reqHeaders = await getL2Headers(apiKey, secret, passphrase, timestamp, method, path, undefined, walletAddress);

  console.log(
    "verifyCredentials request:",
    JSON.stringify({
      url: `${CLOB_HOST}${path}`,
      headers: reqHeaders,
      walletAddress,
      apiKey,
    }),
  );

  const res = await fetch(`${CLOB_HOST}${path}`, {
    method,
    headers: {
      ...reqHeaders,
      "Content-Type": "application/json",
    },
  });

  const body = await res.text();
  console.log(`verifyCredentials response [${res.status}]:`, body);

  return { ok: res.ok, status: res.status, body, headers: Object.fromEntries(res.headers.entries()) };
}

// Get user balance info
async function getBalanceAllowance(
  apiKey: string,
  secret: string,
  passphrase: string,
  tokenId: string,
  walletAddress?: string,
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const signPath = `/balance-allowance`;
  const queryParams = `asset_type=CONDITIONAL&token_id=${tokenId}`;

  const headers = await getL2Headers(apiKey, secret, passphrase, timestamp, method, signPath, undefined, walletAddress);

  const res = await fetch(`${CLOB_HOST}${signPath}?${queryParams}`, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: errText };
  }

  return await res.json();
}

// Get wallet USDC balance on Polygon via public RPC
async function getWalletBalance(walletAddress: string): Promise<{ usdc: number; matic: number }> {
  const POLYGON_RPC = "https://polygon-rpc.com";
  // USDC on Polygon: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (PoS bridged)
  // USDC.e / native USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
  const USDC_ADDRESSES = [
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e (6 decimals)
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC (6 decimals)
  ];

  let totalUsdc = 0;

  for (const usdcAddr of USDC_ADDRESSES) {
    try {
      // ERC20 balanceOf(address) selector: 0x70a08231
      const paddedAddr = walletAddress.replace("0x", "").padStart(64, "0");
      const res = await fetch(POLYGON_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            {
              to: usdcAddr,
              data: `0x70a08231000000000000000000000000${paddedAddr}`,
            },
            "latest",
          ],
          id: 1,
        }),
      });
      const data = await res.json();
      if (data.result && data.result !== "0x") {
        totalUsdc += parseInt(data.result, 16) / 1e6; // USDC has 6 decimals
      }
    } catch (e) {
      console.error(`Error fetching USDC balance from ${usdcAddr}:`, e);
    }
  }

  // Get MATIC balance
  let matic = 0;
  try {
    const res = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBalance",
        params: [walletAddress, "latest"],
        id: 2,
      }),
    });
    const data = await res.json();
    if (data.result) {
      matic = parseInt(data.result, 16) / 1e18;
    }
  } catch (e) {
    console.error("Error fetching MATIC balance:", e);
  }

  return { usdc: totalUsdc, matic };
}

// Sign and submit order using official ClobClient with full EIP-712 signing
// Forces submission via US proxy to bypass geoblocking
async function signAndSubmitOrder(
  walletPrivateKey: string,
  proxyAddress: string | undefined,
  tokenId: string,
  side: "BUY" | "SELL",
  size: number,
  price: number,
  negRisk: boolean = false,
): Promise<any> {
  const { ethers } = await import("https://esm.sh/ethers@5.7.2");
  const pk = walletPrivateKey.startsWith("0x") ? walletPrivateKey : `0x${walletPrivateKey}`;
  const wallet = new ethers.Wallet(pk);

  // Always use sigType=1 (POLY_PROXY) for proxy wallet trading
  const sigType = 1;
  const funderAddress = proxyAddress || wallet.address;

  console.log(`Signing order: sigType=${sigType}, funder=${funderAddress?.substring(0, 10)}, eoa=${wallet.address.substring(0, 10)}`);

  try {
    // Step 1: Create initial client to derive/create API keys (L1 auth)
    const initClient = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, sigType, funderAddress);
    
    // Use createOrDeriveApiKey to get fresh trading credentials
    let creds: any;
    try {
      creds = await initClient.createOrDeriveApiKey();
      console.log("createOrDeriveApiKey success:", creds.apiKey?.substring(0, 8));
    } catch (e1) {
      console.log("createOrDeriveApiKey failed, trying deriveApiKey:", e1);
      try {
        creds = await initClient.deriveApiKey();
        console.log("deriveApiKey fallback success:", creds.apiKey?.substring(0, 8));
      } catch (e2) {
        console.error("Both createOrDeriveApiKey and deriveApiKey failed:", e2);
        return { error: `L2_AUTH_NOT_AVAILABLE: ${e2 instanceof Error ? e2.message : String(e2)}` };
      }
    }

    // Step 2: Create fully authenticated client with derived creds
    const authedClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      wallet,
      { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
      sigType,
      funderAddress,
    );

    // Step 3: Approve USDC spending (idempotent - safe to call every time)
    try {
      console.log("Approving USDC for CTF Exchange...");
      // Polymarket CTF Exchange contract on Polygon
      const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
      const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
      const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      
      // ERC20 approve(spender, amount) - approve max uint256
      const approveData = (spender: string) => {
        const selector = "0x095ea7b3"; // approve(address,uint256)
        const paddedSpender = spender.replace("0x", "").padStart(64, "0");
        const maxAmount = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        return `${selector}${paddedSpender}${maxAmount}`;
      };
      
      // Check current allowance before approving
      const POLYGON_RPC = "https://polygon-rpc.com";
      const checkAllowance = async (spender: string) => {
        const selector = "0xdd62ed3e"; // allowance(owner, spender)
        const paddedOwner = funderAddress.replace("0x", "").toLowerCase().padStart(64, "0");
        const paddedSpender = spender.replace("0x", "").padStart(64, "0");
        const res = await fetch(POLYGON_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "eth_call",
            params: [{ to: USDC_ADDRESS, data: `${selector}${paddedOwner}${paddedSpender}` }, "latest"],
            id: 1,
          }),
        });
        const data = await res.json();
        return data.result && data.result !== "0x" && data.result !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      };

      const [ctfApproved, negApproved] = await Promise.all([
        checkAllowance(CTF_EXCHANGE),
        checkAllowance(NEG_RISK_CTF_EXCHANGE),
      ]);
      
      console.log(`USDC allowances - CTF: ${ctfApproved}, NegRisk: ${negApproved}`);
      // Note: If allowances are missing, trades may fail. User needs to approve via wallet directly.
    } catch (approveErr) {
      console.warn("USDC approval check failed (non-fatal):", approveErr);
    }

    // Step 4: Determine tick size from orderbook
    let tickSize = "0.01";
    try {
      const book = await getOrderbook(tokenId);
      if (book?.market?.minimum_tick_size) {
        tickSize = book.market.minimum_tick_size;
      }
    } catch {}

    const tick = parseFloat(tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    const finalPrice = Math.max(tick, Math.min(1 - tick, roundedPrice));

    console.log(
      `Creating signed order: token=${tokenId.substring(0, 20)}..., side=${side}, size=${size}, price=${finalPrice}, tick=${tickSize}`,
    );

    const clobSide = side === "BUY" ? ClobSide.BUY : ClobSide.SELL;

    // Step 5: Create the signed order
    const signedOrder = await authedClient.createOrder(
      {
        tokenID: tokenId,
        price: finalPrice,
        size: size,
        side: clobSide,
        orderType: OrderType.FOK,
      },
      {
        tickSize,
        negRisk,
      },
    );

    console.log("Order signed successfully, submitting via Bright Data ISP proxy...");

    // Step 6: Submit order directly to Polymarket through Bright Data ISP proxy
    const proxyUrl = Deno.env.get("US_PROXY_URL");
    if (!proxyUrl) {
      return { error: "US_PROXY_URL not configured", signedOrder, finalPrice, tickSize };
    }

    try {
      console.log(`Proxy submit → Bright Data ISP → ${CLOB_HOST}/order`);

      // Build fresh L2 HMAC headers with correct timestamp
      const timestamp = Math.floor(Date.now() / 1000);
      const orderBody = JSON.stringify(signedOrder);
      const l2Headers = await getL2Headers(
        creds.apiKey,
        creds.secret,
        creds.passphrase,
        timestamp,
        "POST",
        "/order",
        orderBody,
        wallet.address,
      );

      const proxyRes = await fetchViaProxy(proxyUrl, `${CLOB_HOST}/order`, {
        method: "POST",
        headers: {
          ...l2Headers,
          "Content-Type": "application/json",
        },
        body: orderBody,
      });

      const proxyBody = await proxyRes.text();
      console.log(`Bright Data proxy response [${proxyRes.status}]: ${proxyBody.substring(0, 500)}`);

      if (proxyRes.ok) {
        let result;
        try {
          result = JSON.parse(proxyBody);
        } catch {
          result = proxyBody;
        }
        console.log(`Order submitted → ID: ${result?.orderID || result?.order_id || JSON.stringify(result).substring(0, 50)}`);
        return {
          submitted: true,
          result,
          finalPrice,
          tickSize,
          via: "brightdata-isp",
        };
      } else {
        console.error(`Order submit FAILED [${proxyRes.status}]: ${proxyBody.substring(0, 300)}`);
        return {
          submitted: false,
          error: `Polymarket returned ${proxyRes.status}: ${proxyBody.substring(0, 200)}`,
          signedOrder,
          finalPrice,
          tickSize,
        };
      }
    } catch (proxyErr) {
      console.error("Bright Data proxy error:", proxyErr);
      return {
        submitted: false,
        error: `Proxy error: ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`,
        signedOrder,
        finalPrice,
        tickSize,
      };
    }
  } catch (e) {
    console.error("Sign order error:", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Get open orders
async function getOpenOrders(apiKey: string, secret: string, passphrase: string, walletAddress?: string): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const path = "/data/orders";

  const headers = await getL2Headers(apiKey, secret, passphrase, timestamp, method, path, undefined, walletAddress);

  const res = await fetch(`${CLOB_HOST}${path}`, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: errText, status: res.status };
  }

  return await res.json();
}

// Get trade history
async function getTradeHistory(
  apiKey: string,
  secret: string,
  passphrase: string,
  walletAddress?: string,
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const path = "/data/trades";

  const headers = await getL2Headers(apiKey, secret, passphrase, timestamp, method, path, undefined, walletAddress);

  const res = await fetch(`${CLOB_HOST}${path}`, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: errText, status: res.status };
  }

  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const POLY_API_KEY = Deno.env.get("POLYMARKET_API_KEY");
    let POLY_SECRET = Deno.env.get("POLYMARKET_API_SECRET");
    const POLY_PASSPHRASE = Deno.env.get("POLYMARKET_PASSPHRASE");

    // Ensure base64 secret has proper padding
    if (POLY_SECRET && POLY_SECRET.length % 4 !== 0) {
      POLY_SECRET = POLY_SECRET + "=".repeat(4 - (POLY_SECRET.length % 4));
    }
    console.log(
      "Auth debug - secret length:",
      POLY_SECRET?.length,
      "ends with =:",
      POLY_SECRET?.endsWith("="),
      "apiKey:",
      POLY_API_KEY?.substring(0, 8),
    );
    const POLY_WALLET_KEY = Deno.env.get("POLYMARKET_WALLET_PRIVATE_KEY");
    const POLY_PROXY_ADDRESS = Deno.env.get("POLYMARKET_PROXY_ADDRESS");

    // Derive EOA wallet address from private key if available
    let eoaAddress = "";
    let eoaAddressChecksum = "";
    if (POLY_WALLET_KEY) {
      try {
        const { ethers } = await import("https://esm.sh/ethers@5.7.2");
        const wallet = new ethers.Wallet(POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`);
        eoaAddress = wallet.address.toLowerCase();
        eoaAddressChecksum = wallet.address; // Keep checksummed version for CLOB API auth
      } catch (e) {
        console.error("Failed to derive wallet address:", e);
      }
    }

    // Use lowercase EOA address for CLOB API L2 auth headers (proven to work with 200 response)
    // Use proxy address for on-chain balance queries and positions
    const clobAuthAddress = eoaAddress;
    const proxyAddress = POLY_PROXY_ADDRESS?.toLowerCase() || eoaAddress;
    const onChainAddress = proxyAddress;

    const { action, ...params } = await req.json();

    switch (action) {
      case "get-prices": {
        // Get prices for multiple token IDs
        const { tokenIds } = params;
        const prices: Record<string, any> = {};
        for (const tid of tokenIds || []) {
          const mid = await getMidpoint(tid);
          prices[tid] = mid;
        }
        return new Response(JSON.stringify({ prices }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-orderbook": {
        const book = await getOrderbook(params.tokenId);
        return new Response(JSON.stringify(book || { error: "Not found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "search-markets": {
        const markets = await searchMarkets(params.query || "");
        return new Response(JSON.stringify({ markets }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-market-tokens": {
        const market = await getMarketTokens(params.conditionId);
        return new Response(JSON.stringify(market || { error: "Not found" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-positions": {
        if (!proxyAddress) {
          return new Response(JSON.stringify({ error: "Wallet private key not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const positions = await getPositions(proxyAddress);
        return new Response(JSON.stringify(positions), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "verify-connection": {
        const connected = !!(POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE && clobAuthAddress);
        let verified = false;
        let eoaBal = { usdc: 0, matic: 0 };
        let proxyBal = { usdc: 0, matic: 0 };
        let polymarketUsdc = 0;
        let positionsValue = 0;
        let verifyDebug: any = null;
        if (connected) {
          // Use L1 auth (EIP-712) for verification since L2 HMAC is unreliable
          let l1VerifyResult: any = { ok: false, status: 0, body: "" };
          if (POLY_WALLET_KEY) {
            try {
              const { ethers } = await import("https://esm.sh/ethers@5.7.2");
              const pk = POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`;
              const wallet = new ethers.Wallet(pk);
              const authAddr = wallet.address; // Must use checksummed address for L1 EIP-712 auth
              const ts = Math.floor(Date.now() / 1000);
              const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
              const types = {
                ClobAuth: [
                  { name: "address", type: "address" },
                  { name: "timestamp", type: "string" },
                  { name: "nonce", type: "uint256" },
                  { name: "message", type: "string" },
                ],
              };
              const value = {
                address: authAddr,
                timestamp: `${ts}`,
                nonce: 0,
                message: "This message attests that I control the given wallet",
              };
              const sig = await wallet._signTypedData(domain, types, value);
              const l1Headers = {
                POLY_ADDRESS: authAddr,
                POLY_SIGNATURE: sig,
                POLY_TIMESTAMP: `${ts}`,
                POLY_NONCE: "0",
              };
              const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
                method: "GET",
                headers: { ...l1Headers, "Content-Type": "application/json" },
              });
              const body = await res.text();
              l1VerifyResult = { ok: res.ok, status: res.status, body };
              console.log(`L1 verify response [${res.status}]:`, body);
            } catch (e) {
              console.error("L1 verify error:", e);
              l1VerifyResult = { ok: false, status: 0, body: String(e) };
            }
          }

          // Query on-chain balances in parallel
          const balQueries: Promise<any>[] = [getWalletBalance(eoaAddress)];
          if (proxyAddress && proxyAddress !== eoaAddress) {
            balQueries.push(getWalletBalance(proxyAddress));
          }
          if (proxyAddress) {
            balQueries.push(getPositions(proxyAddress));
          }
          const balResults = await Promise.all(balQueries);
          eoaBal = balResults[0];
          if (proxyAddress && proxyAddress !== eoaAddress) {
            proxyBal = balResults[1];
          }
          const positionsData = proxyAddress && proxyAddress !== eoaAddress ? balResults[2] : balResults[1];
          if (Array.isArray(positionsData)) {
            for (const pos of positionsData) {
              positionsValue += pos.currentValue || 0;
            }
          }

          verified = l1VerifyResult.ok;
          verifyDebug = { status: l1VerifyResult.status, body: l1VerifyResult.body };

          // Try L2 for CLOB balance, but also try L1 balance endpoint
          try {
            // Try the profile/balance endpoint with L1 auth
            if (POLY_WALLET_KEY) {
              const { ethers } = await import("https://esm.sh/ethers@5.7.2");
              const pk = POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`;
              const wallet = new ethers.Wallet(pk);
              const authAddr = wallet.address; // Must use checksummed address for L1 EIP-712 auth
              const ts = Math.floor(Date.now() / 1000);
              const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
              const types = {
                ClobAuth: [
                  { name: "address", type: "address" },
                  { name: "timestamp", type: "string" },
                  { name: "nonce", type: "uint256" },
                  { name: "message", type: "string" },
                ],
              };
              const value = {
                address: authAddr,
                timestamp: `${ts}`,
                nonce: 0,
                message: "This message attests that I control the given wallet",
              };
              const sig = await wallet._signTypedData(domain, types, value);
              const l1Headers = {
                POLY_ADDRESS: authAddr,
                POLY_SIGNATURE: sig,
                POLY_TIMESTAMP: `${ts}`,
                POLY_NONCE: "0",
              };
              // IMPORTANT: HMAC is signed with JUST the path (no query params)
              // Query params are added to the URL but NOT included in the signature
              const signPath = `/balance-allowance`;
              const balTs = Math.floor(Date.now() / 1000);
              const balHeaders = await getL2Headers(
                POLY_API_KEY!,
                POLY_SECRET!,
                POLY_PASSPHRASE!,
                balTs,
                "GET",
                signPath,
                undefined,
                clobAuthAddress,
              );
              const queryParams = `asset_type=COLLATERAL&signature_type=1`;
              const balRes = await fetch(`${CLOB_HOST}${signPath}?${queryParams}`, {
                method: "GET",
                headers: { ...balHeaders, "Content-Type": "application/json" },
              });
              const balBody = await balRes.text();
              console.log(`Balance-allowance [${balRes.status}]:`, balBody);
              if (balRes.ok) {
                try {
                  const data = JSON.parse(balBody);
                  const rawBalance = parseFloat(data.balance || "0");
                  polymarketUsdc = rawBalance > 1000 ? rawBalance / 1e6 : rawBalance;
                } catch {}
              }
            }
          } catch (e) {
            console.error("Balance fetch error:", e);
          }
        }
        const totalOnChainUsdc = eoaBal.usdc + proxyBal.usdc;
        const totalUsdc = totalOnChainUsdc + polymarketUsdc;
        return new Response(
          JSON.stringify({
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
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      case "get-wallet-balance": {
        if (!clobAuthAddress) {
          return new Response(JSON.stringify({ error: "Wallet not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Get on-chain balances for both EOA and proxy
        const balQueries: Promise<any>[] = [getWalletBalance(eoaAddress)];
        if (proxyAddress && proxyAddress !== eoaAddress) {
          balQueries.push(getWalletBalance(proxyAddress));
        }
        if (proxyAddress) {
          balQueries.push(getPositions(proxyAddress));
        }
        const balResults = await Promise.all(balQueries);
        const eoaOnChain = balResults[0];
        const proxyOnChain = proxyAddress && proxyAddress !== eoaAddress ? balResults[1] : { usdc: 0, matic: 0 };
        const posData = proxyAddress && proxyAddress !== eoaAddress ? balResults[2] : balResults[1];

        let posValue = 0;
        if (Array.isArray(posData)) {
          for (const p of posData) posValue += p.currentValue || 0;
        }

        // Also get Polymarket CLOB USDC balance
        let pmUsdc = 0;
        if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE) {
          try {
            const timestamp = Math.floor(Date.now() / 1000);
            const signPath = `/balance-allowance`;
            const queryParams = `asset_type=COLLATERAL&signature_type=1`;
            const headers = await getL2Headers(
              POLY_API_KEY,
              POLY_SECRET,
              POLY_PASSPHRASE,
              timestamp,
              "GET",
              signPath,
              undefined,
              clobAuthAddress,
            );
            const res = await fetch(`${CLOB_HOST}${signPath}?${queryParams}`, {
              method: "GET",
              headers: { ...headers, "Content-Type": "application/json" },
            });
            if (res.ok) {
              const data = await res.json();
              pmUsdc = parseFloat(data.balance || "0") / 1e6;
            }
          } catch (e) {
            console.error("Error fetching Polymarket USDC balance:", e);
          }
        }

        const totalOnChain = eoaOnChain.usdc + proxyOnChain.usdc;
        return new Response(
          JSON.stringify({
            usdc: totalOnChain + pmUsdc,
            matic: eoaOnChain.matic + proxyOnChain.matic,
            eoaUsdc: eoaOnChain.usdc,
            proxyUsdc: proxyOnChain.usdc,
            polymarketUsdc: pmUsdc,
            positionsValue: posValue,
            total: totalOnChain + pmUsdc + posValue,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      case "get-open-orders": {
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) {
          return new Response(JSON.stringify({ error: "Polymarket API credentials not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const orders = await getOpenOrders(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        return new Response(JSON.stringify(orders), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-trades": {
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) {
          return new Response(JSON.stringify({ error: "Polymarket API credentials not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const trades = await getTradeHistory(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        return new Response(JSON.stringify(trades), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "sign-order":
      case "place-trade": {
        // Both actions sign the order server-side
        // "sign-order" returns the signed payload for client-side submission
        // "place-trade" also returns the signed payload (client submits to bypass geoblock)
        if (!POLY_WALLET_KEY) {
          return new Response(JSON.stringify({ error: "Wallet private key not configured for trading" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const { tokenId, side, size, price, negRisk } = params;
        if (!tokenId || !side || !size || !price) {
          return new Response(JSON.stringify({ error: "Missing required fields: tokenId, side, size, price" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const result = await signAndSubmitOrder(
          POLY_WALLET_KEY,
          POLY_PROXY_ADDRESS || undefined,
          tokenId,
          side,
          size,
          price,
          negRisk || false,
        );

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: result.error ? 400 : 200,
        });
      }

      case "derive-api-key": {
        // One-time L1 auth to derive trading API keys from the wallet private key
        if (!POLY_WALLET_KEY) {
          return new Response(JSON.stringify({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const { ethers } = await import("https://esm.sh/ethers@5.7.2");
          const pk = POLY_WALLET_KEY.startsWith("0x") ? POLY_WALLET_KEY : `0x${POLY_WALLET_KEY}`;
          const wallet = new ethers.Wallet(pk);
          const eoaAddr = wallet.address;
          const proxyAddr = POLY_PROXY_ADDRESS || eoaAddr;
          const useProxy = params.useProxy ?? false;
          const authAddress = useProxy ? proxyAddr : eoaAddr;
          const timestamp = Math.floor(Date.now() / 1000);
          const nonce = params.nonce ?? 0;

          // Build EIP-712 signature for L1 auth
          const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
          const types = {
            ClobAuth: [
              { name: "address", type: "address" },
              { name: "timestamp", type: "string" },
              { name: "nonce", type: "uint256" },
              { name: "message", type: "string" },
            ],
          };
          const value = {
            address: authAddress,
            timestamp: `${timestamp}`,
            nonce,
            message: "This message attests that I control the given wallet",
          };
          const signature = await wallet._signTypedData(domain, types, value);

          const l1Headers = {
            POLY_ADDRESS: authAddress,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: `${timestamp}`,
            POLY_NONCE: `${nonce}`,
          };

          console.log("derive-api-key using address:", authAddress, "useProxy:", useProxy);

          // Try derive first, then create if not found
          let res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
            method: "GET",
            headers: { ...l1Headers, "Content-Type": "application/json" },
          });

          let result;
          if (res.ok) {
            result = await res.json();
          } else {
            const deriveErr = await res.text();
            console.log("Derive failed, trying create:", deriveErr);

            // Try creating new API key
            res = await fetch(`${CLOB_HOST}/auth/api-key`, {
              method: "POST",
              headers: { ...l1Headers, "Content-Type": "application/json" },
            });

            if (!res.ok) {
              const createErr = await res.text();
              return new Response(
                JSON.stringify({ error: `Both derive and create failed. Derive: ${deriveErr}. Create: ${createErr}` }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            result = await res.json();
          }

          return new Response(
            JSON.stringify({
              authAddress,
              eoaAddress: eoaAddr,
              proxyAddress: proxyAddr,
              apiKey: result.apiKey,
              secret: result.secret,
              passphrase: result.passphrase,
              note: "Save these credentials! Update POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE secrets with these values.",
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        } catch (e) {
          console.error("derive-api-key error:", e);
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      case "test-proxy": {
        // Quick test to verify Bright Data ISP proxy connectivity
        const proxyUrl = Deno.env.get("US_PROXY_URL");
        if (!proxyUrl) {
          return new Response(JSON.stringify({ error: "US_PROXY_URL not configured" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        try {
          console.log("Testing proxy connectivity...");
          
          // Test Polymarket endpoint through proxy
          const polyRes = await fetchViaProxy(proxyUrl, `${CLOB_HOST}/time`, {
            method: "GET",
            headers: {},
          });
          const polyBody = await polyRes.text();
          console.log(`Polymarket via proxy [${polyRes.status}]: ${polyBody.substring(0, 200)}`);
          
          return new Response(JSON.stringify({
            polymarketTest: { status: polyRes.status, body: polyBody.substring(0, 200) },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e: any) {
          console.error("Proxy test error:", e);
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    console.error("polymarket-trade error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
