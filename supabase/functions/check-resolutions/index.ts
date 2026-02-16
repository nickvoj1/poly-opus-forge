import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Check if a Polymarket market has resolved and what the outcome was
async function checkMarketResolution(conditionId: string | null, marketSlug: string | null, marketQuestion: string): Promise<{
  resolved: boolean;
  outcome: string | null;
  endDate: string | null;
}> {
  let markets: any[] = [];

  // Priority 1: Use condition_id for exact lookup
  if (conditionId) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}&limit=1`
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) markets = data;
      }
    } catch {}
  }

  // Priority 2: Use slug
  if (markets.length === 0 && marketSlug) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}&limit=1`
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) markets = data;
      }
    } catch {}
  }

  // Priority 3: Search by question (with strict matching)
  if (markets.length === 0 && marketQuestion) {
    try {
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?limit=10&query=${encodeURIComponent(marketQuestion.slice(0, 80))}`
      );
      if (res.ok) {
        const results = await res.json();
        // Strict match: question must closely match
        const questionLower = marketQuestion.toLowerCase();
        markets = results.filter((m: any) => {
          const q = (m.question || "").toLowerCase();
          return q === questionLower || q.includes(questionLower) || questionLower.includes(q);
        });
        // Do NOT fall back to first result if no match — that causes wrong resolutions
      }
    } catch {}
  }

  if (markets.length === 0) {
    return { resolved: false, outcome: null, endDate: null };
  }

  const market = markets[0];

  // Check if market is resolved
  if (market.closed || market.resolved) {
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
      if (!outcome) {
        for (let i = 0; i < prices.length; i++) {
          const p = parseFloat(prices[i]);
          if (p <= 0.05) {
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
  const s = side.toUpperCase();
  
  // Determine which outcome the bettor is backing
  // BUY / BUY_YES / YES → betting on YES
  // BUY_NO / SELL / NO → betting on NO
  const bettingOnYes = s === "BUY" || s === "YES" || s === "BUY_YES";
  const bettingOnNo = s === "SELL" || s === "NO" || s === "BUY_NO" || s === "SELL_YES";

  const won = (bettingOnYes && resolution === "YES") || (bettingOnNo && resolution === "NO");

  if (won) {
    // Payout is 1.0 per share, cost was recommendedPrice per share
    return (1 - recommendedPrice) * size;
  } else {
    // Lost the cost
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
      const resolution = await checkMarketResolution(bet.condition_id || null, bet.market_slug || null, bet.market);

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
