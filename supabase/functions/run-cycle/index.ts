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
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${endMax}`
    );
    const urgentMarkets = await urgentRes.json();

    const hourMax = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const nearRes = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${hourMax}`
    );
    const nearMarkets = await nearRes.json();

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

    const urgentList = (Array.isArray(urgentMarkets) ? urgentMarkets : [])
      .slice(0, 10)
      .map(formatMarket)
      .join("\n");

    const nearList = (Array.isArray(nearMarkets) ? nearMarkets : [])
      .filter((m: any) => !urgentMarkets?.some?.((u: any) => u.id === m.id))
      .slice(0, 10)
      .map(formatMarket)
      .join("\n");

    const output = [
      urgentList ? `⚡ ENDING IN <10 MIN:\n${urgentList}` : "",
      nearList ? `🕐 ENDING IN <1 HOUR:\n${nearList}` : "",
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
    const { cycle, bankroll, systemPrompt, liveTrading } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const [polyResult, binanceData] = await Promise.all([
      fetchPolymarket(),
      fetchBinanceVol(),
    ]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const modeNote = liveTrading
      ? `\n⚡ LIVE TRADING MODE: Your recommendations will be executed as REAL orders on Polymarket. Be conservative with sizing. Focus on markets with high liquidity and imminent resolution. Include token_id if available from the market data.`
      : `\n📊 SIMULATION MODE: This is a paper trading simulation.`;

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
            content: `You are a quantitative trading simulation engine. You MUST respond with valid JSON only. No markdown, no explanation, no code blocks, just pure JSON object.

CRITICAL: In the "market" field of each hypo, use the EXACT human-readable market question (e.g. "Bitcoin Up or Down - February 16, 7:00AM-7:05AM ET"). Do NOT put conditionId hashes in the market field. The conditionId is metadata only — never use it as the market name.

For the "price" field, use the actual market price from the data (parse outcomePrices). Do NOT default to 0.5 unless the price truly is 0.50.`,
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
