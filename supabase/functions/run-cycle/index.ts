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
    const soon = new Date(now.getTime() + 10 * 60 * 1000);
    const endMin = now.toISOString();
    const endMax = soon.toISOString();

    const urgentRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${endMax}`
    );
    const urgentMarkets = await urgentRes.json();

    const hourMax = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const nearRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${hourMax}`
    );
    const nearMarkets = await nearRes.json();

    const trendingRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false`
    );
    const trendingMarkets = await trendingRes.json();

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

    const isHighVolume = (m: any) => (m.volumeNum || 0) >= 10000 || (m.liquidityNum || 0) >= 5000;

    const urgentList = (Array.isArray(urgentMarkets) ? urgentMarkets : [])
      .filter(isHighVolume).slice(0, 15).map(formatMarket).join("\n");

    const nearList = (Array.isArray(nearMarkets) ? nearMarkets : [])
      .filter((m: any) => !urgentMarkets?.some?.((u: any) => u.id === m.id))
      .filter(isHighVolume).slice(0, 15).map(formatMarket).join("\n");

    const trendingList = (Array.isArray(trendingMarkets) ? trendingMarkets : [])
      .filter((m: any) => !urgentMarkets?.some?.((u: any) => u.id === m.id) && !nearMarkets?.some?.((n: any) => n.id === m.id))
      .filter(isHighVolume).slice(0, 10).map(formatMarket).join("\n");

    const output = [
      urgentList ? `⚡ ENDING IN <10 MIN (HIGH VOL):\n${urgentList}` : "",
      nearList ? `🕐 ENDING IN <1 HOUR (HIGH VOL):\n${nearList}` : "",
      trendingList ? `🔥 TRENDING HIGH-VOLUME:\n${trendingList}` : "",
    ].filter(Boolean).join("\n\n");

    return {
      text: `POLYMARKET IMMINENT TRADES:\n${output || "No markets ending soon found."}`,
      marketsMap,
    };
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return { text: "POLYMARKET: fetch error", marketsMap: {} };
  }
}

async function fetchBinanceVol(): Promise<string> {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
    const d = await res.json();
    return `BINANCE BTC/USDT: price=${d.lastPrice} vol24h=${d.volume} high=${d.highPrice} low=${d.lowPrice} change=${d.priceChangePercent}%`;
  } catch {
    return "BINANCE: fetch error";
  }
}

// Execute a single trade by calling the polymarket-trade edge function
async function executeTrade(
  supabaseUrl: string, supabaseKey: string,
  hypo: any, marketsMap: Record<string, any>
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
            const ids = typeof markets[0].clobTokenIds === "string" 
              ? JSON.parse(markets[0].clobTokenIds) : markets[0].clobTokenIds;
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
  const tokenId = isSell ? (tokenIds[1] || tokenIds[0]) : tokenIds[0];
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

  console.log(`🔄 Executing: ${tradeSide} ${hypo.size} of ${hypo.market} @ $${price.toFixed(4)}`);

  // Call polymarket-trade edge function to place the order
  try {
    const tradeRes = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        action: "sign-order",
        tokenId,
        side: tradeSide,
        size: hypo.size,
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

    const [polyResult, binanceData] = await Promise.all([
      fetchPolymarket(),
      fetchBinanceVol(),
    ]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const modeNote = `\n⚡ LIVE TRADING MODE: Aggressive Kelly sizing. Max $2.70 per trade (15% bankroll). Target 20+ trades/day across 4 compounding sessions.`;

    const userMessage = `Cycle ${cycle}. Bankroll: ${bankroll}.${modeNote}

LIVE DATA:
${polyData}
${binanceData}

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
1. EDGE DETECTION: Calculate TRUE probability using BTC momentum, news sentiment, whale flows, volume patterns.
   - Edge = TRUE_prob - market_price. ONLY trade when edge > 15% (0.15).
   - For crypto markets: BTC 24h change is primary signal. Negative → SELL/NO, Positive → BUY/YES.
   - For non-crypto: use volume spikes, liquidity shifts, and time decay as signals.

2. KELLY SIZING: f* = (p*b - q) / b where p=win_prob, q=1-p, b=odds.
   - Use AGGRESSIVE Kelly: bet 15% of bankroll per trade (f* capped at 15%).
   - Live mode: max $2.70 per trade. Sim mode: 15% of bankroll.

3. MARKET SELECTION:
   - ONLY high-volume markets (volume > $10,000 or liquidity > $5,000).
   - Markets ending in <60 minutes preferred, <10 min is ideal for time decay edge.
   - Parse "outcomePrices" as "[YesPrice, NoPrice]". Trade the side priced 0.25-0.65.
   - ALWAYS output at least 1-3 hypos if any markets are available. Be aggressive.

4. COMPOUNDING: Target 5+ trades per cycle. Roll winners into next cycle bankroll.

5. OUTPUT each hypo with: "market" (exact question), "action" (BUY/SELL), "size" (dollar amount), "pnl" (0), "price" (entry price), "edge" (estimated edge), "kelly_f" (kelly fraction used).

CRITICAL: Use EXACT human-readable market question in "market" field. Include "price" with ACTUAL market price. Output format: {"cycle":N,"bankroll":N,"hypos":[...],"log":"..."}`,
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
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `AI gateway error: ${response.status}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    parsed.log = parsed.log || "Cycle complete";

    console.log(`🤖 AI returned ${parsed.hypos.length} trade ideas`);

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

      const filled = tradeResults.filter(t => t.status === "filled").length;
      const failed = tradeResults.filter(t => t.status === "failed").length;
      const skipped = tradeResults.filter(t => t.status === "skipped").length;
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
          "Authorization": `Bearer ${supabaseKey}`,
        },
      });
    } catch {}

    console.log(`✅ Cycle ${cycle} complete`);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("run-cycle error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
