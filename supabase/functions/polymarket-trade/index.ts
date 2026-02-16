import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CLOB_HOST = "https://clob.polymarket.com";

// Build HMAC-SHA256 signature for L2 auth
async function buildHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string
): Promise<string> {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) {
    message += body;
  }

  // Decode base64 secret - handle both standard and URL-safe base64
  const cleanSecret = secret.replace(/-/g, '+').replace(/_/g, '/');
  const binaryStr = atob(cleanSecret);
  const keyData = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    keyData[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageBuffer);
  // Encode result as base64
  const sigArray = new Uint8Array(signatureBuffer);
  let binary = '';
  for (let i = 0; i < sigArray.length; i++) {
    binary += String.fromCharCode(sigArray[i]);
  }
  return btoa(binary);
}

function getL2Headers(
  apiKey: string,
  secret: string,
  passphrase: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
  walletAddress?: string
) {
  return buildHmacSignature(secret, timestamp, method, requestPath, body).then(
    (sig) => ({
      "POLY_ADDRESS": walletAddress || apiKey,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": `${timestamp}`,
      "POLY_API_KEY": apiKey,
      "POLY_PASSPHRASE": passphrase,
    })
  );
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
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10&query=${encodeURIComponent(query)}`
  );
  if (!res.ok) return [];
  return await res.json();
}

// Get user positions from Data API (public, requires wallet address)
async function getPositions(walletAddress: string): Promise<any> {
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${walletAddress}`
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error("Positions fetch error:", res.status, errText);
    return { error: errText, status: res.status };
  }

  return await res.json();
}

// Derive wallet address from private key using basic secp256k1
// We use the CLOB API's /auth/api-keys endpoint to verify credentials
async function verifyCredentials(apiKey: string, secret: string, passphrase: string, walletAddress: string): Promise<{ ok: boolean; status: number; body: string; headers: Record<string, string> }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const path = "/auth/api-keys";

  const reqHeaders = await getL2Headers(apiKey, secret, passphrase, timestamp, method, path, undefined, walletAddress);

  console.log("verifyCredentials request:", JSON.stringify({
    url: `${CLOB_HOST}${path}`,
    headers: reqHeaders,
    walletAddress,
    apiKey,
  }));

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
  walletAddress?: string
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const path = `/data/balance-allowance?asset_type=CONDITIONAL&token_id=${tokenId}`;

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
          params: [{
            to: usdcAddr,
            data: `0x70a08231000000000000000000000000${paddedAddr}`,
          }, "latest"],
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

// Note: This is a simplified version - real order signing requires EIP-712
// For now, we use the CLOB's market order endpoint which handles matching
async function placeOrder(
  apiKey: string,
  secret: string,
  passphrase: string,
  tokenId: string,
  side: "BUY" | "SELL",
  size: number,
  price: number,
  walletAddress?: string
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "POST";
  const path = "/order";

  // Build the order payload
  // The order needs to be signed with EIP-712 using the wallet private key
  // This requires the full signing flow from @polymarket/order-utils
  const orderPayload = {
    order: {
      tokenID: tokenId,
      price: price,
      size: size,
      side: side,
    },
    owner: apiKey,
    orderType: "FOK", // Fill or Kill for market-like orders
  };

  const bodyStr = JSON.stringify(orderPayload);
  const headers = await getL2Headers(apiKey, secret, passphrase, timestamp, method, path, bodyStr, walletAddress);

  const res = await fetch(`${CLOB_HOST}${path}`, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: bodyStr,
  });

  const responseText = await res.text();
  console.log(`Order response [${res.status}]:`, responseText);

  if (!res.ok) {
    return { error: responseText, status: res.status };
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return { result: responseText };
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
async function getTradeHistory(apiKey: string, secret: string, passphrase: string, walletAddress?: string): Promise<any> {
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
    const POLY_SECRET = Deno.env.get("POLYMARKET_API_SECRET");
    const POLY_PASSPHRASE = Deno.env.get("POLYMARKET_PASSPHRASE");
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

    // Use checksummed EOA address for CLOB API L2 auth headers (must match address used to derive API keys)
    // Use proxy address for on-chain balance queries and positions
    const clobAuthAddress = eoaAddressChecksum;
    const proxyAddress = POLY_PROXY_ADDRESS?.toLowerCase() || eoaAddress;
    const onChainAddress = proxyAddress;

    const { action, ...params } = await req.json();

    switch (action) {
      case "get-prices": {
        // Get prices for multiple token IDs
        const { tokenIds } = params;
        const prices: Record<string, any> = {};
        for (const tid of (tokenIds || [])) {
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
          return new Response(
            JSON.stringify({ error: "Wallet private key not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
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
          // Query all balances in parallel
          const queries: Promise<any>[] = [
            verifyCredentials(POLY_API_KEY!, POLY_SECRET!, POLY_PASSPHRASE!, clobAuthAddress),
            getWalletBalance(eoaAddress),
          ];
          if (proxyAddress && proxyAddress !== eoaAddress) {
            queries.push(getWalletBalance(proxyAddress));
          }
          // Get positions value
          if (proxyAddress) {
            queries.push(getPositions(proxyAddress));
          }

          const results = await Promise.all(queries);
          const verifyResult = results[0];
          eoaBal = results[1];
          if (proxyAddress && proxyAddress !== eoaAddress) {
            proxyBal = results[2];
          }
          
          // Calculate positions value
          const positionsData = proxyAddress && proxyAddress !== eoaAddress ? results[3] : results[2];
          if (Array.isArray(positionsData)) {
            for (const pos of positionsData) {
              positionsValue += pos.currentValue || 0;
            }
          }

          verified = verifyResult.ok;
          verifyDebug = { status: verifyResult.status, body: verifyResult.body };
          
          // Get Polymarket CLOB USDC balance
          try {
            const timestamp = Math.floor(Date.now() / 1000);
            const path = `/data/balance-allowance?asset_type=COLLATERAL`;
            const headers = await getL2Headers(POLY_API_KEY!, POLY_SECRET!, POLY_PASSPHRASE!, timestamp, "GET", path, undefined, clobAuthAddress);
            const res = await fetch(`${CLOB_HOST}${path}`, {
              method: "GET",
              headers: { ...headers, "Content-Type": "application/json" },
            });
            if (res.ok) {
              const data = await res.json();
              polymarketUsdc = parseFloat(data.balance || "0") / 1e6;
            }
          } catch {}
        }
        const totalOnChainUsdc = eoaBal.usdc + proxyBal.usdc;
        const totalUsdc = totalOnChainUsdc + polymarketUsdc;
        return new Response(JSON.stringify({ 
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
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-wallet-balance": {
        if (!clobAuthAddress) {
          return new Response(
            JSON.stringify({ error: "Wallet not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
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
        const proxyOnChain = (proxyAddress && proxyAddress !== eoaAddress) ? balResults[1] : { usdc: 0, matic: 0 };
        const posData = (proxyAddress && proxyAddress !== eoaAddress) ? balResults[2] : balResults[1];
        
        let posValue = 0;
        if (Array.isArray(posData)) {
          for (const p of posData) posValue += p.currentValue || 0;
        }
        
        // Also get Polymarket CLOB USDC balance
        let pmUsdc = 0;
        if (POLY_API_KEY && POLY_SECRET && POLY_PASSPHRASE) {
          try {
            const timestamp = Math.floor(Date.now() / 1000);
            const path = `/data/balance-allowance?asset_type=COLLATERAL`;
            const headers = await getL2Headers(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, timestamp, "GET", path, undefined, clobAuthAddress);
            const res = await fetch(`${CLOB_HOST}${path}`, {
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
        return new Response(JSON.stringify({ 
          usdc: totalOnChain + pmUsdc, 
          matic: eoaOnChain.matic + proxyOnChain.matic,
          eoaUsdc: eoaOnChain.usdc,
          proxyUsdc: proxyOnChain.usdc,
          polymarketUsdc: pmUsdc,
          positionsValue: posValue,
          total: totalOnChain + pmUsdc + posValue,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-open-orders": {
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) {
          return new Response(
            JSON.stringify({ error: "Polymarket API credentials not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const orders = await getOpenOrders(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        return new Response(JSON.stringify(orders), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "get-trades": {
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) {
          return new Response(
            JSON.stringify({ error: "Polymarket API credentials not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const trades = await getTradeHistory(POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE, clobAuthAddress);
        return new Response(JSON.stringify(trades), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "place-trade": {
        if (!POLY_API_KEY || !POLY_SECRET || !POLY_PASSPHRASE) {
          return new Response(
            JSON.stringify({ error: "Polymarket API credentials not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { tokenId, side, size, price } = params;
        if (!tokenId || !side || !size || !price) {
          return new Response(
            JSON.stringify({ error: "Missing required fields: tokenId, side, size, price" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const result = await placeOrder(
          POLY_API_KEY,
          POLY_SECRET,
          POLY_PASSPHRASE,
          tokenId,
          side,
          size,
          price,
          clobAuthAddress
        );

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: result.error ? 400 : 200,
        });
      }

      case "derive-api-key": {
        // One-time L1 auth to derive trading API keys from the wallet private key
        if (!POLY_WALLET_KEY) {
          return new Response(
            JSON.stringify({ error: "POLYMARKET_WALLET_PRIVATE_KEY not configured" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
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
            "POLY_ADDRESS": authAddress,
            "POLY_SIGNATURE": signature,
            "POLY_TIMESTAMP": `${timestamp}`,
            "POLY_NONCE": `${nonce}`,
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
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
            result = await res.json();
          }

          return new Response(JSON.stringify({
            authAddress,
            eoaAddress: eoaAddr,
            proxyAddress: proxyAddr,
            apiKey: result.apiKey,
            secret: result.secret,
            passphrase: result.passphrase,
            note: "Save these credentials! Update POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE secrets with these values.",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("derive-api-key error:", e);
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (e) {
    console.error("polymarket-trade error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
