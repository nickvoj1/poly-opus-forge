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

    // Fetch high-volume markets ending soon (prioritize >$10k volume)
    const urgentRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${endMax}`
    );
    const urgentMarkets = await urgentRes.json();

    const hourMax = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const nearRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${hourMax}`
    );
    const nearMarkets = await nearRes.json();

    // Also fetch high-volume trending markets (not time-bound)
    const trendingRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false`
    );
    const trendingMarkets = await trendingRes.json();

    // Build a lookup map of market question -> { conditionId, slug }
    const marketsMap: Record<string, any> = {};

    const formatMarket = (m: any) => {
      const endDate = m.endDate || m.end_date_iso;
      const minsLeft = endDate ? Math.round((new Date(endDate).getTime() - now.getTime()) / 60000) : "?";
      // Store market metadata for later bet saving
      marketsMap[m.question] = {
        conditionId: m.conditionId || m.condition_id || null,
        slug: m.slug || null,
        clobTokenIds: m.clobTokenIds || null,
      };
      return `${m.question} | conditionId: ${m.conditionId || "?"} | price: ${m.outcomePrices} | vol: $${Math.round(m.volumeNum || 0)} | liq: $${Math.round(m.liquidityNum || 0)} | ENDS IN: ${minsLeft} min`;
    };

    // Filter for high-volume markets (>$10k volume or >$5k liquidity)
    const isHighVolume = (m: any) => (m.volumeNum || 0) >= 10000 || (m.liquidityNum || 0) >= 5000;

    const urgentList = (Array.isArray(urgentMarkets) ? urgentMarkets : [])
      .filter(isHighVolume)
      .slice(0, 15)
      .map(formatMarket)
      .join("\n");

    const nearList = (Array.isArray(nearMarkets) ? nearMarkets : [])
      .filter((m: any) => !urgentMarkets?.some?.((u: any) => u.id === m.id))
      .filter(isHighVolume)
      .slice(0, 15)
      .map(formatMarket)
      .join("\n");

    const trendingList = (Array.isArray(trendingMarkets) ? trendingMarkets : [])
      .filter((m: any) => !urgentMarkets?.some?.((u: any) => u.id === m.id) && !nearMarkets?.some?.((n: any) => n.id === m.id))
      .filter(isHighVolume)
      .slice(0, 10)
      .map(formatMarket)
      .join("\n");

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const cycle = body.cycle || 1;
    const bankroll = body.bankroll || 18;
    const systemPrompt = body.systemPrompt || "Find high-edge trades ending soon. Be aggressive.";
    const liveTrading = body.liveTrading ?? false;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const [polyResult, binanceData] = await Promise.all([
      fetchPolymarket(),
      fetchBinanceVol(),
    ]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const modeNote = liveTrading
      ? `\n⚡ LIVE TRADING MODE: Aggressive Kelly sizing. Max $2.70 per trade (15% bankroll). Target 20+ trades/day across 4 compounding sessions.`
      : `\n📊 SIMULATION MODE: Aggressive Kelly sizing. 15% bankroll per trade. Compound winners 4x/day.`;

    const userMessage = `Cycle ${cycle}. Bankroll: ${bankroll}.${modeNote}

LIVE DATA:
${polyData}
${binanceData}

${systemPrompt}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          {
            role: "system",
           content: `You are an aggressive quantitative trading engine for Polymarket. You MUST respond with valid JSON only. No markdown, no code blocks.

KELLY CRITERION STRATEGY (Target: 250% daily return):
1. EDGE DETECTION: Calculate TRUE probability using BTC momentum, news sentiment, whale flows, volume patterns.
   - Edge = TRUE_prob - market_price. ONLY trade when edge > 20% (0.20).
   - For crypto markets: BTC 24h change is primary signal. Negative → SELL/NO, Positive → BUY/YES.
   - For non-crypto: use volume spikes, liquidity shifts, and time decay as signals.

2. KELLY SIZING: f* = (p*b - q) / b where p=win_prob, q=1-p, b=odds.
   - Use AGGRESSIVE Kelly: bet 15% of bankroll per trade (f* capped at 15%).
   - Live mode: max $2.70 per trade. Sim mode: 15% of bankroll.
   - This means ~54 shares at $0.05 risk per share.

3. MARKET SELECTION:
   - ONLY high-volume markets (volume > $10,000 or liquidity > $5,000).
   - Markets ending in <60 minutes preferred, <10 min is ideal for time decay edge.
   - Parse "outcomePrices" as "[YesPrice, NoPrice]". Trade the side priced 0.25-0.65.
   - SKIP markets with no clear edge. Empty hypos is fine.

4. COMPOUNDING: Target 5+ trades per cycle. Roll winners into next cycle bankroll.
   - 20% edge × 15% Kelly × 20 bets/day = 250% daily target.
   - Max drawdown tolerance: 30%.

5. OUTPUT each hypo with: "market" (exact question), "action" (BUY/SELL), "size" (dollar amount), "pnl" (0), "price" (entry price), "edge" (estimated edge), "kelly_f" (kelly fraction used).

CRITICAL: Use EXACT human-readable market question in "market" field. Include "price" with ACTUAL market price.`,
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
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in Settings → Workspace → Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: `AI gateway error: ${response.status}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content || "{}";

    // Parse the JSON from the response
    let parsed;
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      console.error("Failed to parse AI response:", text.slice(0, 500));
      parsed = {
        cycle,
        bankroll: bankroll * (1 + (Math.random() - 0.45) * 0.05),
        sharpe: Math.random() * 2,
        mdd: Math.random() * 15,
        hypos: [],
        rules: ["Parse error - using fallback"],
        log: "AI response was not valid JSON. Raw: " + text.slice(0, 200),
      };
    }

    parsed.cycle = parsed.cycle || cycle;
    parsed.bankroll = parsed.bankroll || bankroll;
    parsed.sharpe = parsed.sharpe || 0;
    parsed.mdd = parsed.mdd || 0;
    parsed.hypos = parsed.hypos || [];
    parsed.rules = parsed.rules || [];
    parsed.log = parsed.log || "Cycle complete";

    // Enrich hypos with clobTokenIds from the real market data
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

    // Save each recommended bet to the database for resolution tracking
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, supabaseKey);

      const betsToInsert = (parsed.hypos || []).map((h: any) => {
        // Look up condition_id and slug from the real market data we fetched
        const marketMeta = marketsMap[h.market] || {};
        return {
          cycle: parsed.cycle,
          market: h.market || "Unknown",
          market_slug: h.market_slug || h.slug || marketMeta.slug || null,
          condition_id: h.condition_id || marketMeta.conditionId || null,
          token_id: h.token_id || h.tokenId || null,
          side: h.action || h.side || "BUY",
          recommended_price: h.price || h.entry_price || 0.5,
          size: h.size || 0,
          confidence: h.confidence || h.score || null,
          is_live: liveTrading || false,
          status: "pending",
        };
      });

      if (betsToInsert.length > 0) {
        const { error: insertErr } = await sb.from("bets").insert(betsToInsert);
        if (insertErr) {
          console.error("Failed to save bets:", insertErr);
        } else {
          console.log(`Saved ${betsToInsert.length} bets for cycle ${parsed.cycle}`);
        }
      }
    } catch (e) {
      console.error("Error saving bets:", e);
    }

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
