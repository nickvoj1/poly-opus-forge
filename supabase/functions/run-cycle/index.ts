import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function fetchPolymarket(): Promise<string> {
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&limit=30&order=liquidityNum&ascending=false"
    );
    const markets = await res.json();
    const top = markets
      .filter((m: any) => (m.liquidityNum || 0) > 15000)
      .slice(0, 15)
      .map((m: any) => `${m.question} | price: ${m.outcomePrices} | vol: $${Math.round(m.volumeNum || 0)} | liq: $${Math.round(m.liquidityNum || 0)}`)
      .join("\n");
    return `POLYMARKET LIVE:\n${top || "No high-liquidity markets found."}`;
  } catch (e) {
    return "POLYMARKET: fetch error";
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
    const { cycle, bankroll, systemPrompt } = await req.json();
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    const [polyData, binanceData] = await Promise.all([
      fetchPolymarket(),
      fetchBinanceVol(),
    ]);

    const userMessage = `Cycle ${cycle}. Bankroll: ${bankroll}.

LIVE DATA:
${polyData}
${binanceData}

${systemPrompt}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        max_tokens: 4000,
        system: "You are a quantitative trading simulation engine. You MUST respond with valid JSON only. No markdown, no explanation, just pure JSON.",
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic error:", response.status, errText);
      return new Response(JSON.stringify({ error: `Claude API error: ${response.status}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "{}";

    // Parse the JSON from Claude's response
    let parsed;
    try {
      // Try to extract JSON if wrapped in code blocks
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      console.error("Failed to parse Claude response:", text);
      parsed = {
        cycle,
        bankroll: bankroll * (1 + (Math.random() - 0.45) * 0.05),
        sharpe: Math.random() * 2,
        mdd: Math.random() * 15,
        hypos: [],
        rules: ["Parse error - using fallback"],
        log: "Claude response was not valid JSON. Raw: " + text.slice(0, 200),
      };
    }

    // Ensure required fields
    parsed.cycle = parsed.cycle || cycle;
    parsed.bankroll = parsed.bankroll || bankroll;
    parsed.sharpe = parsed.sharpe || 0;
    parsed.mdd = parsed.mdd || 0;
    parsed.hypos = parsed.hypos || [];
    parsed.rules = parsed.rules || [];
    parsed.log = parsed.log || "Cycle complete";

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
