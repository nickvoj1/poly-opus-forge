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
// Attempts submission via US proxy first, falls back to direct (which gets geoblocked)
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

  const sigType = proxyAddress ? 1 : 0;
  const funderAddress = proxyAddress || wallet.address;

  console.log(`Signing order: sigType=${sigType}, funder=${funderAddress?.substring(0, 10)}`);

  const client = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, sigType, funderAddress);

  try {
    const creds = await client.deriveApiKey();
    console.log("Derived API creds:", creds.apiKey?.substring(0, 8));

    const authedClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      wallet,
      { key: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
      sigType,
      funderAddress,
    );

    // Determine tick size
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

    // Create the signed order WITHOUT posting it
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

    console.log("Order signed successfully");

    // Try submitting via US proxy if configured
    const US_PROXY_URL = "http://35.229.117.3:3128"; // HARDCODE relay
    if (US_PROXY_URL) {
      try {
        console.log(`Submitting order via US proxy: ${US_PROXY_URL}`);

        // Build L2 HMAC headers for the order submission
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
          funderAddress?.toLowerCase(),
        );

        const proxyRes = await fetch(`${US_PROXY_URL}/submit-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order: signedOrder,
            polyHeaders: {
              ...l2Headers,
              "Content-Type": "application/json",
            },
            targetUrl: `${CLOB_HOST}/order`,
          }),
        });

        const proxyBody = await proxyRes.text();
        console.log(`US proxy response [${proxyRes.status}]: ${proxyBody.substring(0, 300)}`);

        if (proxyRes.ok) {
          let result;
          try {
            result = JSON.parse(proxyBody);
          } catch {
            result = proxyBody;
          }
          console.log("Order submitted via US proxy successfully!");
          return {
            submitted: true,
            result,
            finalPrice,
            tickSize,
            via: "us-proxy",
          };
        } else {
          console.error("US proxy submission failed, returning signed order");
        }
      } catch (proxyErr) {
        console.error("US proxy error:", proxyErr);
      }
    }

    // Fallback: return signed order for tracking only
    console.log("Order signed & verified (no proxy available or proxy failed)");
    return {
      submitted: false,
      signedOrder,
      finalPrice,
      tickSize,
    };
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

      case "proxy-submit": {
        // Browser sends signed order here, edge function forwards to Polymarket
        // This bypasses CORS (browser→edge function is same-origin-ish)
        // Note: this WILL get 403 geoblocked from EU servers, but we try anyway
        const { signedOrder: order, headers: polyHeaders, submitUrl } = params;
        if (!order || !polyHeaders || !submitUrl) {
          return new Response(JSON.stringify({ error: "Missing signedOrder, headers, or submitUrl" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const orderBody = JSON.stringify(order);
          const proxyRes = await fetch(submitUrl, {
            method: "POST",
            headers: {
              ...polyHeaders,
              "Content-Type": "application/json",
            },
            body: orderBody,
          });
          const proxyBody = await proxyRes.text();
          console.log(`Proxy submit [${proxyRes.status}]: ${proxyBody.substring(0, 300)}`);

          return new Response(proxyBody, {
            status: proxyRes.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e: any) {
          console.error("Proxy submit error:", e);
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
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
