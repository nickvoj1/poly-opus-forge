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
    const soon5 = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    // Fetch ONLY markets ending in ≤5 minutes + crypto-specific searches (filtered later)
    const queries = [
      // Primary: ending ≤5 min
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${soon5}`,
      ),
      // Crypto-specific searches (will be filtered to ≤5 min)
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

    // Filter to ONLY markets ending in ≤5 minutes
    const fiveMinMs = 5 * 60 * 1000;
    const eligible = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      if (!end) return false;
      const diff = new Date(end).getTime() - now.getTime();
      return diff > 0 && diff <= fiveMinMs;
    });

    // Sort by volume
    const byVol = (a: any, b: any) => (b.volumeNum || 0) - (a.volumeNum || 0);

    const section = eligible.length
      ? `⚡ ENDING ≤5 MIN (${eligible.length}):\n${eligible.sort(byVol).slice(0, 30).map(formatMarket).join("\n")}`
      : "No markets ending in ≤5 minutes found.";

    console.log(`📊 Scanned ${allMarkets.length} unique markets → ${eligible.length} ending in ≤5 min`);

    return {
      text: `POLYMARKET CRYPTO MARKETS ENDING ≤5 MIN (${eligible.length} total):\n${section}`,
      marketsMap,
    };
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return { text: "POLYMARKET: fetch error", marketsMap: {} };
  }
}

async function fetchCryptoPrices(): Promise<string> {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
  try {
    const results = await Promise.all(
      symbols.map(async (sym) => {
        try {
          const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
          const d = await res.json();
          return `${sym}: $${parseFloat(d.lastPrice).toFixed(2)} (${d.priceChangePercent > 0 ? "+" : ""}${d.priceChangePercent}% 24h, vol=$${Math.round(parseFloat(d.quoteVolume) / 1e6)}M)`;
        } catch {
          return `${sym}: error`;
        }
      }),
    );
    return `CRYPTO PRICES:\n${results.join("\n")}`;
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

  // Get token IDs from market data
  const rawIds = hypo.clobTokenIds || meta.clobTokenIds;
  if (rawIds) {
    try {
      tokenIds = typeof rawIds === "string" ? JSON.parse(rawIds) : rawIds;
    } catch {}
  }

  // If no token IDs from market data, try fetching from Gamma API
  if (tokenIds.length === 0) {
    const conditionId = hypo.condition_id || meta.conditionId;
    if (conditionId) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
        if (res.ok) {
          const markets = await res.json();
          if (markets[0]?.clobTokenIds) {
            const ids =
              typeof markets[0].clobTokenIds === "string"
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

  // For SELL/BUY_NO, use the NO token (index 1); for BUY, use YES token (index 0)
  const action = (hypo.action || "BUY").toUpperCase();
  const isSell = action === "SELL" || action === "BUY_NO";
  const tokenId = isSell ? tokenIds[1] || tokenIds[0] : tokenIds[0];
  const tradeSide = isSell ? "SELL" : "BUY";

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

  // Call polymarket-trade edge function to place the order
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
      console.log(`✅ FILLED: ${tradeSide} ${hypo.size} @ $${result.finalPrice} (${result.via})`);
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

    const [polyResult, cryptoData] = await Promise.all([fetchPolymarket(), fetchCryptoPrices()]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const userMessage = `Cycle ${cycle}. Bankroll: $${bankroll}.
⚡ LIVE TRADING MODE: Aggressive Kelly sizing. Max $2.70 per trade (15% bankroll).

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
            content: `You are an aggressive quantitative trading engine for Polymarket. You MUST respond with valid JSON only. No markdown, no code blocks.

KELLY CRITERION STRATEGY (Target: 250% daily return):

1. EDGE DETECTION:
   - Edge = TRUE_prob - market_price. Minimum edge threshold: 8% (0.08).
   - BTC 24h change is PRIMARY signal: Negative → bet DOWN/SELL, Positive → bet UP/BUY.
   - Cross-asset correlation: If BTC is up, ETH/SOL/XRP likely follow. Do NOT bet against BTC trend unless you have specific divergence evidence.
   - Time decay: markets ending <10 min with mispriced odds = highest edge.
   - You MUST explain your reasoning for each trade in the "reasoning" field.

2. KELLY SIZING (VARIABLE — NOT FLAT):
   - f* = (p*b - q) / b where p=win_prob, q=1-p, b=payout odds.
   - Size MUST vary by edge strength:
     * Edge 8-12%: size = 5% of bankroll
     * Edge 12-20%: size = 10% of bankroll
     * Edge 20%+: size = 15% of bankroll (max)
   - Live mode hard cap: $2.70 per trade. Sim mode: use % of bankroll.
   - NEVER use flat sizing. Each trade size must reflect its calculated kelly_f.

3. MARKET SELECTION:
   - ONLY CRYPTO markets. Ignore ALL non-crypto (politics, sports, weather, etc.).
   - ONLY markets ending in ≤5 MINUTES. Do NOT trade ANY market ending later than 5 min.
   - ONLY high-volume markets (volume > $10,000 or liquidity > $5,000).
   - STRICT PRICE BOUNDS: Only trade sides priced between 0.15 and 0.75. REJECT any trade outside this range.
   - Parse "outcomePrices" as "[YesPrice, NoPrice]". Choose the side within 0.15-0.75.
   - Output 2-5 hypos. If edge is marginal (8-12%), trade with smaller size.

4. ACTIONS:
   - BUY = buy the YES token (betting market resolves YES/Up).
   - SELL = buy the NO token (betting market resolves NO/Down).
   - Be explicit: if you think a crypto will go DOWN, use action "SELL".

5. OUTPUT FORMAT (all fields required):
   {"cycle":N, "bankroll":N, "sharpe":N, "mdd":N, "hypos":[...], "rules":["rule1","rule2"], "log":"summary"}

   Each hypo MUST include ALL of these fields:
   - "market": exact market question string
   - "action": "BUY" or "SELL"
   - "size": dollar amount (variable based on edge, NOT flat)
   - "pnl": 0
   - "price": entry price (must be 0.15-0.75)
   - "edge": calculated edge as decimal (e.g. 0.15)
   - "kelly_f": actual kelly fraction used (e.g. 0.05, 0.10, 0.15)
   - "reasoning": 1-2 sentence explanation of WHY this trade has edge

6. SHARPE & MDD:
   - "sharpe": estimate rolling Sharpe ratio from recent cycles. If cycle 1, estimate from expected edge.
   - "mdd": max drawdown % from peak bankroll. If cycle 1, set to 0.
   - "rules": list 2-4 key rules/observations driving this cycle's decisions.

CRITICAL: ONLY trade CRYPTO markets ending SOON (<60 min). Use EXACT market question in "market" field. Variable sizing is MANDATORY.`,
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

    // Server-side validation: filter out bad trades
    const preFilterCount = parsed.hypos.length;
    parsed.hypos = parsed.hypos.filter((h: any) => {
      const price = h.price || 0;
      if (price < 0.15 || price > 0.75) {
        console.log(`🚫 Rejected ${h.market}: price ${price} outside 0.15-0.75 bounds`);
        return false;
      }
      const edge = h.edge || 0;
      if (edge < 0.08) {
        console.log(`🚫 Rejected ${h.market}: edge ${edge} below 8% threshold`);
        return false;
      }
      if (!h.market || typeof h.market !== "string") {
        console.log(`🚫 Rejected trade: missing market name`);
        return false;
      }
      return true;
    });

    if (preFilterCount !== parsed.hypos.length) {
      console.log(`🔍 Validated: ${parsed.hypos.length}/${preFilterCount} trades passed filters`);
      parsed.log += ` | Filtered: ${preFilterCount - parsed.hypos.length} rejected (price/edge bounds)`;
    }

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
    const sb = createClient(supabaseUrl, supabaseKey);
    const tradeResults: any[] = [];

    if (liveTrading && parsed.hypos.length > 0) {
      console.log(`⚡ Executing ${parsed.hypos.length} live trades...`);

      for (const hypo of parsed.hypos.slice(0, 10)) {
        const tradeResult = await executeTrade(supabaseUrl, supabaseKey, hypo, marketsMap);
        tradeResults.push({ market: hypo.market, ...tradeResult });

        // Save bet to database with execution status
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
        if (insertErr) {
          console.error(`Failed to save bet for ${hypo.market}:`, insertErr);
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
