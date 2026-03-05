import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function fetchPolymarket(): Promise<{ text: string; marketsMap: Record<string, any> }> {
  try {
    const now = new Date();
    const endMin = now.toISOString();
    const soon60 = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const soon4h = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();

    // Fetch markets ending in ≤4 hours + crypto-specific searches
    const queries = [
      // Primary: ending ≤60 min (highest priority)
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${soon60}`,
      ),
      // Extended: ending 1-4 hours (15-min and hourly markets)
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true&end_date_min=${soon60}&end_date_max=${soon4h}`,
      ),
      // Crypto-specific searches
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false&tag=crypto`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Bitcoin`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Ethereum`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Solana`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&query=XRP`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&query=Dogecoin`),
    ];

    const responses = await Promise.all(queries);
    const allData = await Promise.all(responses.map((r) => (r.ok ? r.json() : [])));

    // Deduplicate by market ID
    const seen = new Set<string>();
    const allMarkets: any[] = [];
    for (const markets of allData) {
      if (!Array.isArray(markets)) continue;
      for (const m of markets) {
        if (m.id && !seen.has(m.id)) {
          seen.add(m.id);
          allMarkets.push(m);
        }
      }
    }

    const marketsMap: Record<string, any> = {};
    const formatMarket = (m: any) => {
      const endDate = m.endDate || m.end_date_iso;
      const minsLeft = endDate ? Math.round((new Date(endDate).getTime() - now.getTime()) / 60000) : "?";
      marketsMap[m.question] = {
        conditionId: m.conditionId || m.condition_id || null,
        slug: m.slug || null,
        clobTokenIds: m.clobTokenIds || null,
      };
      return `${m.question} | conditionId: ${m.conditionId || "?"} | price: ${m.outcomePrices} | vol: $${Math.round(m.volumeNum || 0)} | liq: $${Math.round(m.liquidityNum || 0)} | ENDS IN: ${minsLeft} min`;
    };

    // Filter to markets ending ≤4 hours
    const maxMs = 4 * 60 * 60 * 1000;
    const eligible = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      if (!end) return false;
      const diff = new Date(end).getTime() - now.getTime();
      return diff > 0 && diff <= maxMs;
    });

    // Categorize by urgency
    const getDiff = (m: any) => new Date(m.endDate || m.end_date_iso).getTime() - now.getTime();
    const under5 = eligible.filter((m) => getDiff(m) <= 5 * 60 * 1000);
    const under30 = eligible.filter((m) => { const d = getDiff(m); return d > 5 * 60 * 1000 && d <= 30 * 60 * 1000; });
    const under60 = eligible.filter((m) => { const d = getDiff(m); return d > 30 * 60 * 1000 && d <= 60 * 60 * 1000; });
    const under2h = eligible.filter((m) => { const d = getDiff(m); return d > 60 * 60 * 1000 && d <= 2 * 60 * 60 * 1000; });
    const under4h = eligible.filter((m) => { const d = getDiff(m); return d > 2 * 60 * 60 * 1000 && d <= 4 * 60 * 60 * 1000; });

    const byVol = (a: any, b: any) => (b.volumeNum || 0) - (a.volumeNum || 0);

    const sections = [
      under5.length
        ? `⚡ ENDING ≤5 MIN (${under5.length}):\n${under5.sort(byVol).slice(0, 15).map(formatMarket).join("\n")}`
        : "",
      under30.length
        ? `🕐 ENDING 5-30 MIN (${under30.length}):\n${under30.sort(byVol).slice(0, 15).map(formatMarket).join("\n")}`
        : "",
      under60.length
        ? `⏳ ENDING 30-60 MIN (${under60.length}):\n${under60.sort(byVol).slice(0, 10).map(formatMarket).join("\n")}`
        : "",
      under2h.length
        ? `🕑 ENDING 1-2 HOURS (${under2h.length}):\n${under2h.sort(byVol).slice(0, 10).map(formatMarket).join("\n")}`
        : "",
      under4h.length
        ? `🕓 ENDING 2-4 HOURS (${under4h.length}):\n${under4h.sort(byVol).slice(0, 8).map(formatMarket).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    console.log(`📊 Scanned ${allMarkets.length} unique markets → ${eligible.length} ending ≤4h (${under5.length} ≤5m, ${under30.length} 5-30m, ${under60.length} 30-60m, ${under2h.length} 1-2h, ${under4h.length} 2-4h)`);

    return {
      text: `POLYMARKET CRYPTO MARKETS ENDING ≤4 HOURS (${eligible.length} total):\n${sections || "No active markets found."}`,
      marketsMap,
    };
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return { text: "POLYMARKET: fetch error", marketsMap: {} };
  }
}

// Fetch multi-timeframe candle data from Binance for momentum signals
async function fetchCryptoPrices(): Promise<string> {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
  try {
    const results = await Promise.all(
      symbols.map(async (sym) => {
        try {
          // Fetch 24h ticker + 5m, 15m, and 1h candles for multi-timeframe momentum
          const [tickerRes, klines5mRes, klines15mRes, klines1hRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m&limit=3`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=3`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=3`),
          ]);
          const d = await tickerRes.json();
          const klines5m = await klines5mRes.json();
          const klines15m = await klines15mRes.json();
          const klines1h = await klines1hRes.json();

          const parseCandles = (klines: any[], label: string) => {
            if (!Array.isArray(klines) || klines.length < 2) return "";
            const prev = klines[klines.length - 2];
            const curr = klines[klines.length - 1];
            const prevClose = parseFloat(prev[4]);
            const currClose = parseFloat(curr[4]);
            const change = ((currClose - prevClose) / prevClose * 100).toFixed(3);
            const prevChange = ((prevClose - parseFloat(prev[1])) / parseFloat(prev[1]) * 100).toFixed(3);
            return `${label}: ${Number(change) > 0 ? "+" : ""}${change}% (prev: ${Number(prevChange) > 0 ? "+" : ""}${prevChange}%)`;
          };

          const c5m = parseCandles(klines5m, "5m");
          const c15m = parseCandles(klines15m, "15m");
          const c1h = parseCandles(klines1h, "1h");

          return `${sym}: $${parseFloat(d.lastPrice).toFixed(2)} (24h: ${d.priceChangePercent > 0 ? "+" : ""}${d.priceChangePercent}% | ${c5m} | ${c15m} | ${c1h} | vol=$${Math.round(parseFloat(d.quoteVolume) / 1e6)}M)`;
        } catch {
          return `${sym}: error`;
        }
      }),
    );
    return `CRYPTO PRICES (multi-timeframe momentum: 5m, 15m, 1h candles):\n${results.join("\n")}`;
  } catch {
    return "CRYPTO PRICES: fetch error";
  }
}

// Execute a single trade by calling the polymarket-trade edge function
async function executeTrade(
  supabaseUrl: string,
  supabaseKey: string,
  hypo: any,
  marketsMap: Record<string, any>,
): Promise<{ status: string; price: number; error?: string; orderID?: string }> {
  const meta = marketsMap[hypo.market] || {};
  let tokenIds: string[] = [];

  const rawIds = hypo.clobTokenIds || meta.clobTokenIds;
  if (rawIds) {
    try {
      tokenIds = typeof rawIds === "string" ? JSON.parse(rawIds) : rawIds;
    } catch {}
  }

  if (tokenIds.length === 0) {
    const conditionId = hypo.condition_id || meta.conditionId;
    if (conditionId) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
        if (res.ok) {
          const markets = await res.json();
          if (markets[0]?.clobTokenIds) {
            const ids = typeof markets[0].clobTokenIds === "string"
              ? JSON.parse(markets[0].clobTokenIds)
              : markets[0].clobTokenIds;
            tokenIds = ids;
          }
        }
      } catch {}
    }
  }

  if (tokenIds.length === 0) {
    console.log(`⚠ No token IDs for ${hypo.market}, skipping`);
    return { status: "skipped", price: hypo.price || 0.5, error: "no_token_ids" };
  }

  const action = (hypo.action || "BUY").toUpperCase();
  const isSell = action === "SELL" || action === "BUY_NO";
  // CRITICAL: On Polymarket, to bet DOWN you BUY the NO token (tokenIds[1])
  // You can't SELL tokens you don't own. So "SELL" in our strategy = BUY NO token.
  const tokenId = isSell ? (tokenIds[1] || tokenIds[0]) : tokenIds[0];
  const tradeSide = "BUY"; // Always BUY — either YES token (bet up) or NO token (bet down)

  // Get live midpoint price
  let price = hypo.price || 0.5;
  try {
    const midRes = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
    if (midRes.ok) {
      const midData = await midRes.json();
      if (midData.mid) price = parseFloat(midData.mid);
    }
  } catch {}

  // Ensure order value meets Polymarket's $1 minimum
  const minSize = Math.ceil(1 / price);
  const adjustedSize = Math.max(hypo.size, minSize);
  if (adjustedSize !== hypo.size) {
    console.log(`📐 Size adjusted: ${hypo.size} → ${adjustedSize} (min value $1 at price $${price.toFixed(4)})`);
  }

  console.log(`🔄 Executing: ${tradeSide} ${adjustedSize} of ${hypo.market} @ $${price.toFixed(4)}`);

  try {
    const tradeRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
      },
      body: JSON.stringify({
        action: "place-trade",
        tokenId,
        side: tradeSide,
        size: adjustedSize,
        price,
      }),
    });

    const result = await tradeRes.json();

    if (result?.submitted) {
      console.log(`✅ FILLED: ${tradeSide} ${adjustedSize} @ $${result.finalPrice} (${result.via})`);
      return { status: "filled", price: result.finalPrice || price, orderID: result.result?.orderID };
    } else {
      console.error(`❌ Trade failed: ${result?.error || "unknown"}`);
      return { status: "failed", price, error: result?.error || "submission_failed" };
    }
  } catch (e) {
    console.error(`❌ Trade error: ${e}`);
    return { status: "failed", price, error: e instanceof Error ? e.message : String(e) };
  }
}

// Manage all open positions: take-profit, stop-loss, pre-expiry exit
async function managePositions(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<{ closed: number; pnl: number; actions: string[] }> {
  let closed = 0;
  let totalPnl = 0;
  const actions: string[] = [];

  try {
    const posRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
      },
      body: JSON.stringify({ action: "get-positions" }),
    });

    const positions = await posRes.json();
    if (!Array.isArray(positions) || positions.length === 0) return { closed: 0, pnl: 0, actions: [] };

    const now = Date.now();

    for (const pos of positions) {
      const size = Number(pos.size || 0);
      const avgPrice = Number(pos.avgPrice || pos.avg_price || 0);
      const curPrice = Number(pos.curPrice || pos.cur_price || pos.price || 0);
      const tokenId = pos.asset || pos.token_id;
      const title = pos.title || pos.market || "Unknown";

      if (size <= 0 || !tokenId) continue;

      // Skip already-resolved positions (curPrice = 0 and redeemable)
      if (curPrice === 0 && pos.redeemable) {
        actions.push(`⏭ ${title}: expired, redeemable (no action needed)`);
        continue;
      }

      const unrealizedPnl = (curPrice - avgPrice) * size;
      const pnlPct = avgPrice > 0 ? (curPrice - avgPrice) / avgPrice : 0;

      // Check time to expiry — handle both ISO datetime and date-only formats
      const endDate = pos.endDate || pos.end_date;
      let msToExpiry = Infinity;
      if (endDate) {
        // If it already has a time component (T or includes :), parse directly
        const dateStr = endDate.includes("T") || endDate.includes(":") ? endDate : `${endDate}T23:59:59Z`;
        msToExpiry = new Date(dateStr).getTime() - now;
      }
      // Also check market title for time hints (e.g. "7:55AM-8:00AM ET")
      const timeMatch = title.match(/(\d{1,2}):(\d{2})(AM|PM)\s*(?:-\s*(\d{1,2}):(\d{2})(AM|PM))?\s*ET/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[4] || timeMatch[1]); // Use end time if range
        const mins = parseInt(timeMatch[5] || timeMatch[2]);
        const ampm = (timeMatch[6] || timeMatch[3]).toUpperCase();
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
        const today = new Date();
        const etOffset = -5; // ET = UTC-5 (EST)
        const expiryUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours - etOffset, mins));
        const titleMsToExpiry = expiryUtc.getTime() - now;
        if (titleMsToExpiry > 0 && titleMsToExpiry < msToExpiry) {
          msToExpiry = titleMsToExpiry;
        }
      }
      const minsToExpiry = msToExpiry / 60000;

      let shouldClose = false;
      let reason = "";

      // RULE 1: TAKE PROFIT — close if profit > 8%
      if (pnlPct > 0.08) {
        shouldClose = true;
        reason = `TAKE PROFIT: +${(pnlPct * 100).toFixed(1)}% ($${unrealizedPnl.toFixed(2)})`;
      }
      // RULE 2: STOP LOSS — close if loss > 25%
      else if (pnlPct < -0.25 && curPrice > 0) {
        shouldClose = true;
        reason = `STOP LOSS: ${(pnlPct * 100).toFixed(1)}% ($${unrealizedPnl.toFixed(2)})`;
      }
      // RULE 3: PRE-EXPIRY EXIT — if <2 min to expiry and any profit, take it
      else if (minsToExpiry < 2 && pnlPct > 0) {
        shouldClose = true;
        reason = `PRE-EXPIRY: ${minsToExpiry.toFixed(0)}min left, locking +${(pnlPct * 100).toFixed(1)}%`;
      }
      // RULE 4: PRE-EXPIRY CUT — if <1 min to expiry and losing, cut to avoid full loss
      else if (minsToExpiry < 1 && curPrice > 0.05) {
        shouldClose = true;
        reason = `PRE-EXPIRY CUT: ${minsToExpiry.toFixed(0)}min left, salvaging $${(curPrice * size).toFixed(2)}`;
      }

      if (!shouldClose) {
        actions.push(`📊 HOLD: ${title} | entry=$${avgPrice.toFixed(3)} cur=$${curPrice.toFixed(3)} pnl=${(pnlPct * 100).toFixed(1)}%`);
        continue;
      }

      console.log(`🔄 ${reason} → Selling ${title}`);
      actions.push(`${reason} → SELLING ${title}`);

      try {
        // Sell at slightly below market for quick FAK fill
        const sellPrice = Math.max(0.01, curPrice * 0.95);
        const sellSize = Math.max(1, Math.floor(size));

        const sellRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
            apikey: supabaseKey,
          },
          body: JSON.stringify({
            action: "place-trade",
            tokenId,
            side: "SELL",
            size: sellSize,
            price: sellPrice,
          }),
        });

        const sellResult = await sellRes.json();
        if (sellResult?.submitted) {
          closed++;
          totalPnl += unrealizedPnl;
          console.log(`✅ Closed: ${title} | ${reason}`);
          actions.push(`✅ CLOSED: ${title} for $${unrealizedPnl.toFixed(2)}`);
        } else {
          console.log(`⚠ Failed to close ${title}: ${sellResult?.error || "unknown"}`);
          actions.push(`⚠ FAILED to close ${title}: ${sellResult?.error || "unknown"}`);
        }
      } catch (e) {
        console.error(`Failed to close ${title}:`, e);
      }
    }
  } catch (e) {
    console.error("Error managing positions:", e);
  }

  return { closed, pnl: totalPnl, actions };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const cycle = body.cycle || 1;
    const bankroll = body.bankroll || 18;
    const systemPrompt = body.systemPrompt || "Find high-edge trades ending soon. Be aggressive.";
    const liveTrading = body.liveTrading ?? true;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Step 0: Manage positions — take profit, stop loss, pre-expiry exits
    if (liveTrading) {
      const mgmt = await managePositions(supabaseUrl, supabaseKey);
      if (mgmt.actions.length > 0) {
        console.log(`📋 Position management: ${mgmt.closed} closed, P&L: $${mgmt.pnl.toFixed(2)}`);
        for (const a of mgmt.actions) console.log(`  ${a}`);
      }
    }

    // Step 0.5: Fetch real wallet balance for live trading
    let walletUsdc = bankroll;
    if (liveTrading) {
      try {
        const balRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseKey}`,
            apikey: supabaseKey,
          },
          body: JSON.stringify({ action: "get-wallet-balance" }),
        });
        const balData = await balRes.json();
        if (typeof balData.usdc === "number") {
          walletUsdc = balData.usdc;
          console.log(`💰 Wallet: $${walletUsdc.toFixed(2)} USDC available`);
        }
      } catch (e) {
        console.log("⚠ Could not fetch wallet balance, using provided bankroll");
      }
    }

    const effectiveBankroll = liveTrading ? walletUsdc : bankroll;

    // Fetch existing pending bets to avoid duplicates
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data: pendingBets } = await sb.from("bets").select("market").eq("status", "pending").eq("is_live", liveTrading);
    const existingMarkets = new Set((pendingBets || []).map((b: any) => b.market));
    if (existingMarkets.size > 0) {
      console.log(`📋 Existing pending bets: ${existingMarkets.size} markets (will skip duplicates)`);
    }

    const [polyResult, cryptoData] = await Promise.all([fetchPolymarket(), fetchCryptoPrices()]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const existingMarketsStr = existingMarkets.size > 0
      ? `\nALREADY HAVE POSITIONS IN (DO NOT TRADE THESE): ${[...existingMarkets].join(", ")}`
      : "";

    const userMessage = `Cycle ${cycle}. Bankroll: $${effectiveBankroll.toFixed(2)}.${liveTrading ? ` WALLET BALANCE: $${walletUsdc.toFixed(2)} USDC. Do NOT place trades exceeding this balance.` : ""}
Trade markets ending ≤4 hours. Match candle timeframe to market duration: 5m candles for ≤15min markets, 15m candles for 15-60min markets, 1h candles for 1-4h markets.${existingMarketsStr}

LIVE DATA:
${polyData}
${cryptoData}

${systemPrompt}`;

    console.log(`🚀 Cycle ${cycle} starting (bankroll: $${bankroll}, live: ${liveTrading})`);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are a disciplined quantitative trading engine for Polymarket. You MUST respond with valid JSON only. No markdown, no code blocks.

STRATEGY: MULTI-TIMEFRAME MISPRICED ODDS + MOMENTUM

1. TIMEFRAME-MATCHED EDGE DETECTION:
   - Markets ending ≤15 min: Use 5m candle data as PRIMARY signal. Edge threshold: 15%.
   - Markets ending 15-60 min: Use 15m candle data as PRIMARY signal. Edge threshold: 12%.
   - Markets ending 1-4 hours: Use 1h candle data as PRIMARY signal. Edge threshold: 10%.
   - Always confirm with the next shorter timeframe (e.g., 15m signal confirmed by 5m).
   - Edge = |TRUE_prob - market_price|.

2. DIRECTIONAL SIGNALS — FOLLOW MOMENTUM, NEVER GO CONTRARIAN:
   - PRIMARY candle POSITIVE + confirmation POSITIVE → strong UP → BUY
   - PRIMARY candle NEGATIVE + confirmation NEGATIVE → strong DOWN → SELL
   - PRIMARY candle POSITIVE + confirmation NEGATIVE → reversal → BUY only if very mispriced
   - PRIMARY candle NEGATIVE + confirmation POSITIVE → reversal → SELL only if very mispriced
   - Both flat (< ±0.05%) → NO SIGNAL → SKIP entirely
   
   CRITICAL: NEVER make "contrarian" bets. If momentum is DOWN, do NOT buy YES. If momentum is UP, do NOT buy NO.

3. PRICE = PROBABILITY MAPPING:
   - Market price is the YES probability. BUY = buy YES token (bet UP). SELL = buy NO token (bet DOWN).
   - NEVER buy YES when momentum is DOWN. NEVER buy NO when momentum is UP.

4. STRICT PRICE BOUNDS BY TIMEFRAME:
   - ≤5 min: BUY if price < 0.30, SELL if price > 0.70
   - 5-30 min: BUY if price < 0.35, SELL if price > 0.65
   - 30-60 min: BUY if price < 0.40, SELL if price > 0.60
   - 1-2 hours: BUY if price < 0.42, SELL if price > 0.58
   - 2-4 hours: BUY if price < 0.45, SELL if price > 0.55

5. KELLY SIZING (VARIABLE):
   - Edge 10-15%: size = 3% of bankroll
   - Edge 15-25%: size = 7% of bankroll
   - Edge 25%+: size = 12% of bankroll (max)
   - Live mode hard cap: $2.70 per trade.

6. PRIORITY: Prefer shorter-duration markets (more edge, faster resolution). Only trade 1-4h markets if they show strong multi-timeframe alignment AND significant mispricing.

7. OUTPUT FORMAT (all fields required):
   {"cycle":N, "bankroll":N, "sharpe":N, "mdd":N, "hypos":[...], "rules":["rule1","rule2"], "log":"summary"}

   Each hypo MUST include:
   - "market": exact market question string
   - "action": "BUY" or "SELL"
   - "size": dollar amount
   - "pnl": 0
   - "price": entry price
   - "edge": calculated edge as decimal
   - "kelly_f": fraction used
   - "timeframe": market duration category (e.g., "5m", "15m", "1h", "2h")
   - "reasoning": MUST state: 1) which candle timeframe used, 2) direction + confirmation, 3) why price is mispriced

CRITICAL RULES:
- FOLLOW MOMENTUM. Never go contrarian.
- Match candle timeframe to market duration.
- ONLY trade CLEARLY mispriced odds. If in doubt, SKIP.
- If no markets are mispriced enough, return EMPTY hypos.
- Use EXACT market question in "market" field.`,
          },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please wait and try again." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `AI gateway error: ${response.status}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      console.error("Failed to parse AI response:", text.slice(0, 500));
      parsed = { cycle, bankroll, hypos: [], log: "AI response parse error: " + text.slice(0, 200) };
    }

    parsed.cycle = parsed.cycle || cycle;
    parsed.bankroll = parsed.bankroll || bankroll;
    parsed.hypos = parsed.hypos || [];
    parsed.sharpe = parsed.sharpe ?? 0;
    parsed.mdd = parsed.mdd ?? 0;
    parsed.rules = parsed.rules || [];
    parsed.log = parsed.log || "Cycle complete";

    // Server-side validation: filter out bad trades and duplicates
    const preFilterCount = parsed.hypos.length;
    parsed.hypos = parsed.hypos.filter((h: any) => {
      if (!h.market || typeof h.market !== "string") {
        console.log(`🚫 Rejected trade: missing market name`);
        return false;
      }
      // Dedup: skip if we already have a pending bet on this market
      if (existingMarkets.has(h.market)) {
        console.log(`🚫 Rejected ${h.market}: already have a pending position`);
        return false;
      }
      const price = h.price || 0;
      if (price < 0.10 || price > 0.85) {
        console.log(`🚫 Rejected ${h.market}: price ${price} outside bounds`);
        return false;
      }
      const edge = h.edge || 0;
      if (edge < 0.08) {
        console.log(`🚫 Rejected ${h.market}: edge ${edge} below 8% threshold`);
        return false;
      }
      // Momentum-direction validation
      const action = (h.action || "").toUpperCase();
      const reasoning = (h.reasoning || "").toLowerCase();
      if (action === "BUY" && (reasoning.includes("negative momentum") || reasoning.includes("contrarian"))) {
        console.log(`🚫 Rejected ${h.market}: BUY contradicts negative momentum`);
        return false;
      }
      if (action === "SELL" && (reasoning.includes("positive momentum") || reasoning.includes("contrarian"))) {
        console.log(`🚫 Rejected ${h.market}: SELL contradicts positive momentum`);
        return false;
      }
      return true;
    });

    if (preFilterCount !== parsed.hypos.length) {
      console.log(`🔍 Validated: ${parsed.hypos.length}/${preFilterCount} trades passed filters`);
      parsed.log += ` | Filtered: ${preFilterCount - parsed.hypos.length} rejected`;
    }

    // Server-side Kelly sizing enforcement using real wallet balance
    let totalAllocated = 0;
    for (const h of parsed.hypos) {
      const edge = h.edge || 0;
      let kellyFraction: number;
      if (edge >= 0.25) {
        kellyFraction = 0.12;
      } else if (edge >= 0.15) {
        kellyFraction = 0.07;
      } else {
        kellyFraction = 0.03;
      }
      const kellySize = Math.round(effectiveBankroll * kellyFraction * 100) / 100;
      const cappedSize = liveTrading ? Math.min(kellySize, 2.70) : kellySize;
      // Ensure we don't exceed remaining wallet balance
      const remainingBalance = liveTrading ? Math.max(0, walletUsdc - totalAllocated) : Infinity;
      const finalSize = liveTrading ? Math.min(cappedSize, remainingBalance - 0.50) : cappedSize; // keep $0.50 buffer
      if (finalSize < 0.50) {
        console.log(`🚫 Skipping ${h.market}: insufficient balance (remaining: $${remainingBalance.toFixed(2)})`);
        h._skip = true;
        continue;
      }
      if (finalSize !== h.size) {
        console.log(`📐 Kelly override: ${h.market} edge=${edge} → f=${kellyFraction} → $${h.size} → $${finalSize} (wallet: $${walletUsdc.toFixed(2)})`);
      }
      h.kelly_f = kellyFraction;
      h.size = finalSize;
      totalAllocated += finalSize;
    }
    // Remove skipped trades
    parsed.hypos = parsed.hypos.filter((h: any) => !h._skip);

    console.log(`🤖 AI returned ${parsed.hypos.length} valid trade ideas`);

    // Enrich hypos with token IDs from market data
    for (const h of parsed.hypos) {
      const meta = marketsMap[h.market];
      if (meta?.clobTokenIds) {
        try {
          h.clobTokenIds = typeof meta.clobTokenIds === "string" ? JSON.parse(meta.clobTokenIds) : meta.clobTokenIds;
        } catch {}
      }
      if (meta?.conditionId) h.condition_id = meta.conditionId;
      if (meta?.slug) h.market_slug = meta.slug;
    }

    // Execute trades and save results
    const tradeResults: any[] = [];

    if (liveTrading && parsed.hypos.length > 0) {
      console.log(`⚡ Executing ${parsed.hypos.length} live GTC trades...`);

      const orderIds: string[] = [];

      for (const hypo of parsed.hypos.slice(0, 10)) {
        const tradeResult = await executeTrade(supabaseUrl, supabaseKey, hypo, marketsMap);
        tradeResults.push({ market: hypo.market, ...tradeResult });

        // Track order IDs for auto-cancel
        if (tradeResult.orderID) orderIds.push(tradeResult.orderID);

        const marketMeta = marketsMap[hypo.market] || {};
        const betData = {
          cycle: parsed.cycle,
          market: hypo.market || "Unknown",
          market_slug: hypo.market_slug || marketMeta.slug || null,
          condition_id: hypo.condition_id || marketMeta.conditionId || null,
          token_id: null,
          side: hypo.action || "BUY",
          recommended_price: tradeResult.price || hypo.price || 0.5,
          size: hypo.size || 0,
          confidence: hypo.edge || hypo.confidence || null,
          is_live: true,
          status: tradeResult.status === "filled" ? "pending" : tradeResult.status,
        };

        const { error: insertErr } = await sb.from("bets").insert(betData);
        if (insertErr) console.error(`Failed to save bet for ${hypo.market}:`, insertErr);
      }

      // Wait 10 seconds for GTC orders to fill, then cancel unfilled ones
      // Short wait because most markets are 5-15 min — can't afford to wait long
      if (orderIds.length > 0) {
        console.log(`⏳ Waiting 10s for ${orderIds.length} GTC orders to fill...`);
        await new Promise((r) => setTimeout(r, 10000));

        // Cancel all open orders to prevent stale positions
        try {
          const cancelRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseKey}`,
              apikey: supabaseKey,
            },
            body: JSON.stringify({ action: "cancel-all-orders" }),
          });
          const cancelResult = await cancelRes.json();
          console.log(`🧹 Auto-cancel result:`, JSON.stringify(cancelResult).substring(0, 200));
        } catch (e) {
          console.error("Auto-cancel error:", e);
        }
      }

      const filled = tradeResults.filter((t) => t.status === "filled").length;
      const failed = tradeResults.filter((t) => t.status === "failed").length;
      const skipped = tradeResults.filter((t) => t.status === "skipped").length;
      console.log(`📊 Results: ${filled} filled, ${failed} failed, ${skipped} skipped`);
      parsed.tradeResults = tradeResults;
      parsed.log += ` | Trades: ${filled}/${tradeResults.length} filled`;
    } else if (parsed.hypos.length === 0) {
      console.log("📭 No trade opportunities found this cycle");
      parsed.log += " | No trades found";
    } else {
      // Save as recommendations only (sim mode)
      const betsToInsert = parsed.hypos.map((h: any) => {
        const marketMeta = marketsMap[h.market] || {};
        return {
          cycle: parsed.cycle,
          market: h.market || "Unknown",
          market_slug: h.market_slug || marketMeta.slug || null,
          condition_id: h.condition_id || marketMeta.conditionId || null,
          token_id: null,
          side: h.action || "BUY",
          recommended_price: h.price || 0.5,
          size: h.size || 0,
          confidence: h.edge || null,
          is_live: false,
          status: "pending",
        };
      });
      if (betsToInsert.length > 0) {
        const { error: insertErr } = await sb.from("bets").insert(betsToInsert);
        if (insertErr) console.error("Failed to save bets:", insertErr);
        else console.log(`Saved ${betsToInsert.length} sim bets for cycle ${parsed.cycle}`);
      }
    }

    // Also check resolutions for any pending bets
    try {
      await fetch(`${supabaseUrl}/functions/v1/check-resolutions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
      });
    } catch {}

    console.log(`✅ Cycle ${cycle} complete`);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("run-cycle error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
