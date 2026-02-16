import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Check if a Polymarket market has resolved and what the outcome was
async function checkMarketResolution(marketSlug: string, marketQuestion: string): Promise<{
  resolved: boolean;
  outcome: string | null;
  endDate: string | null;
}> {
  // Try slug first, then search by question
  let markets: any[] = [];

  if (marketSlug) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}&limit=1`
      );
      if (res.ok) markets = await res.json();
    } catch {}
  }

  if (markets.length === 0 && marketQuestion) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?limit=5&query=${encodeURIComponent(marketQuestion.slice(0, 80))}`
      );
      if (res.ok) {
        const results = await res.json();
        // Find best match
        markets = results.filter((m: any) =>
          m.question?.toLowerCase().includes(marketQuestion.toLowerCase().slice(0, 30))
        );
        if (markets.length === 0) markets = results.slice(0, 1);
      }
    } catch {}
  }

  if (markets.length === 0) {
    return { resolved: false, outcome: null, endDate: null };
  }

  const market = markets[0];

  // Check if market is resolved
  // Gamma API: closed=true and resolutionSource exist when resolved
  if (market.closed || market.resolved) {
    // Determine outcome from outcomePrices — the winning outcome will be at 1.0
    let outcome: string | null = null;
    try {
      const prices = JSON.parse(market.outcomePrices || "[]");
      const outcomes = JSON.parse(market.outcomes || '["Yes","No"]');
      
      for (let i = 0; i < prices.length; i++) {
        const p = parseFloat(prices[i]);
        if (p >= 0.95) {
          outcome = outcomes[i] || (i === 0 ? "Yes" : "No");
          break;
        }
      }
      // If no clear winner found but market is closed, check if price is very low (< 0.05)
      if (!outcome) {
        for (let i = 0; i < prices.length; i++) {
          const p = parseFloat(prices[i]);
          if (p <= 0.05) {
            // The OTHER outcome won
            const winnerIdx = i === 0 ? 1 : 0;
            outcome = outcomes[winnerIdx] || (winnerIdx === 0 ? "Yes" : "No");
            break;
          }
        }
      }
    } catch {}

    return {
      resolved: true,
      outcome: outcome?.toUpperCase() || null,
      endDate: market.endDate || market.end_date_iso || null,
    };
  }

  return { resolved: false, outcome: null, endDate: market.endDate || null };
}

// Calculate P&L for a bet given its resolution
function calculatePnL(side: string, recommendedPrice: number, size: number, resolution: string): number {
  // Normalize side
  const normalizedSide = side.toUpperCase();
  const won =
    (normalizedSide === "BUY" || normalizedSide === "YES") && resolution === "YES" ||
    (normalizedSide === "SELL" || normalizedSide === "NO") && resolution === "NO";

  if (won) {
    // Bought at recommendedPrice, pays out 1.0 per share
    // PnL = (1 - price) * size
    return (1 - recommendedPrice) * size;
  } else {
    // Lost the bet, lose the cost
    // PnL = -price * size
    return -recommendedPrice * size;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch all pending bets
    const { data: pendingBets, error: fetchErr } = await supabase
      .from("bets")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (fetchErr) throw fetchErr;

    if (!pendingBets || pendingBets.length === 0) {
      return new Response(JSON.stringify({ checked: 0, resolved: 0, message: "No pending bets" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let resolvedCount = 0;
    const results: any[] = [];

    for (const bet of pendingBets) {
      const resolution = await checkMarketResolution(bet.market_slug || "", bet.market);

      if (resolution.resolved && resolution.outcome) {
        const pnl = calculatePnL(bet.side, Number(bet.recommended_price), Number(bet.size), resolution.outcome);

        const { error: updateErr } = await supabase
          .from("bets")
          .update({
            status: pnl >= 0 ? "won" : "lost",
            resolution: resolution.outcome,
            resolved_at: new Date().toISOString(),
            pnl,
          })
          .eq("id", bet.id);

        if (!updateErr) {
          resolvedCount++;
          results.push({
            id: bet.id,
            market: bet.market,
            side: bet.side,
            price: bet.recommended_price,
            resolution: resolution.outcome,
            pnl,
            status: pnl >= 0 ? "won" : "lost",
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        checked: pendingBets.length,
        resolved: resolvedCount,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("check-resolutions error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
