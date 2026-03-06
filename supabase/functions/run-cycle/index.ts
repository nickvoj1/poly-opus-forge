import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_TRADES_PER_CYCLE = Number(Deno.env.get("MAX_TRADES_PER_CYCLE") || 2);
const MAX_CONCURRENT_TRADES = Number(Deno.env.get("MAX_CONCURRENT_TRADES") || 2);
const MAX_DAILY_LIVE_RISK_USD = Number(Deno.env.get("MAX_DAILY_LIVE_RISK_USD") || 60);
const MAX_OPEN_LIVE_BETS = Number(Deno.env.get("MAX_OPEN_LIVE_BETS") || 30);
const MAX_DAILY_LOSS_USD = Number(Deno.env.get("MAX_DAILY_LOSS_USD") || -30);
const FAILURE_CIRCUIT_BREAKER_RATIO = Number(Deno.env.get("FAILURE_CIRCUIT_BREAKER_RATIO") || 0.45);
const TRADE_TIMEOUT_MS = Number(Deno.env.get("TRADE_TIMEOUT_MS") || 12000);
const MIN_EDGE_TO_TRADE = Number(Deno.env.get("MIN_EDGE_TO_TRADE") || 0.08);
const MIN_LIQUIDITY_TO_TRADE = Number(Deno.env.get("MIN_LIQUIDITY_TO_TRADE") || 5000);
const MIN_VOLUME_TO_TRADE = Number(Deno.env.get("MIN_VOLUME_TO_TRADE") || 10000);
const MIN_ODDS_TO_TRADE = Number(Deno.env.get("MIN_ODDS_TO_TRADE") || 0.08);
const MAX_ODDS_TO_TRADE = Number(Deno.env.get("MAX_ODDS_TO_TRADE") || 0.92);
const MAX_MARKET_MINUTES = Number(Deno.env.get("MAX_MARKET_MINUTES") || 90);
const PRICE_CROSS_AGGRESSION = Number(Deno.env.get("PRICE_CROSS_AGGRESSION") || 0.03);
const MAX_PRICE_DRIFT = Number(Deno.env.get("MAX_PRICE_DRIFT") || 0.12);
const MAX_PER_MARKET_LIVE_RISK_USD = Number(Deno.env.get("MAX_PER_MARKET_LIVE_RISK_USD") || 12);
const MAX_PER_TOKEN_LIVE_RISK_USD = Number(Deno.env.get("MAX_PER_TOKEN_LIVE_RISK_USD") || 12);
const MARKET_COOLDOWN_MINUTES = Number(Deno.env.get("MARKET_COOLDOWN_MINUTES") || 20);
const MIN_EXPECTED_VALUE_USD = Number(Deno.env.get("MIN_EXPECTED_VALUE_USD") || 0.05);
const KELLY_FRACTION = Number(Deno.env.get("KELLY_FRACTION") || 0.2);
const MIN_KELLY_FRACTION_PER_TRADE = Number(Deno.env.get("MIN_KELLY_FRACTION_PER_TRADE") || 0.01);
const MAX_KELLY_FRACTION_PER_TRADE = Number(Deno.env.get("MAX_KELLY_FRACTION_PER_TRADE") || 0.06);
const URGENT_MARKET_SIZE_MULTIPLIER = Number(Deno.env.get("URGENT_MARKET_SIZE_MULTIPLIER") || 0.75);
const MIN_LIVE_TRADE_SIZE_USD = Number(Deno.env.get("MIN_LIVE_TRADE_SIZE_USD") || 1);
const MAX_TRADE_SIZE_PCT = Number(Deno.env.get("MAX_TRADE_SIZE_PCT") || 0.08);
const MAX_DAILY_RISK_PCT = Number(Deno.env.get("MAX_DAILY_RISK_PCT") || 0.35);
const MAX_DAILY_LOSS_PCT = Number(Deno.env.get("MAX_DAILY_LOSS_PCT") || 0.2);
const MAX_OPEN_PENDING_RISK_PCT = Number(Deno.env.get("MAX_OPEN_PENDING_RISK_PCT") || 0.25);
const MAX_MARKET_EXPOSURE_PCT = Number(Deno.env.get("MAX_MARKET_EXPOSURE_PCT") || 0.12);
const MAX_TOKEN_EXPOSURE_PCT = Number(Deno.env.get("MAX_TOKEN_EXPOSURE_PCT") || 0.12);
const MAX_CONSECUTIVE_LOSSES = Number(Deno.env.get("MAX_CONSECUTIVE_LOSSES") || 3);
const LOSS_STREAK_COOLDOWN_MINUTES = Number(Deno.env.get("LOSS_STREAK_COOLDOWN_MINUTES") || 45);

interface TradeExecResult {
  market: string;
  tokenId?: string;
  side?: string;
  size?: number;
  status: "pending" | "filled" | "failed" | "skipped";
  price: number;
  error?: string;
  orderID?: string;
  relayStatus?: number;
}

interface ExposureContext {
  marketRiskUsd: Record<string, number>;
  tokenRiskUsd: Record<string, number>;
  recentMarketTs: Record<string, number>;
}

async function fetchPolymarket(): Promise<{ text: string; marketsMap: Record<string, any> }> {
  try {
    const now = new Date();
    const endMin = now.toISOString();
    const soon10 = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const soon60 = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const soon4h = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
    const soon24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    // Fetch ALL crypto markets across multiple time horizons + categories
    const queries = [
      // Urgent: ending <10 min
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${soon10}`,
      ),
      // Near: ending <1 hour
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${soon10}&end_date_max=${soon60}`,
      ),
      // Medium: ending 1-4 hours
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${soon60}&end_date_max=${soon4h}`,
      ),
      // Longer: ending 4-24 hours
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=endDate&ascending=true&end_date_min=${soon4h}&end_date_max=${soon24h}`,
      ),
      // Top volume across all crypto
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false`),
      // Top liquidity
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=liquidityNum&ascending=false`,
      ),
      // Crypto-specific searches
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&order=volume&ascending=false&tag=crypto`,
      ),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Bitcoin`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Ethereum`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&query=Solana`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&query=XRP`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&query=Dogecoin`),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&query=crypto`),
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
        outcomePrices: m.outcomePrices || null,
        volumeNum: Number(m.volumeNum || 0),
        liquidityNum: Number(m.liquidityNum || 0),
        endDate: m.endDate || m.end_date_iso || null,
      };
      return `${m.question} | conditionId: ${m.conditionId || "?"} | price: ${m.outcomePrices} | vol: $${Math.round(m.volumeNum || 0)} | liq: $${Math.round(m.liquidityNum || 0)} | ENDS IN: ${minsLeft} min`;
    };

    // Categorize markets
    const urgent = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      return end && new Date(end).getTime() - now.getTime() < 10 * 60 * 1000;
    });
    const nearTerm = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      const diff = end ? new Date(end).getTime() - now.getTime() : Infinity;
      return diff >= 10 * 60 * 1000 && diff < 60 * 60 * 1000;
    });
    const medium = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      const diff = end ? new Date(end).getTime() - now.getTime() : Infinity;
      return diff >= 60 * 60 * 1000 && diff < 4 * 60 * 60 * 1000;
    });
    const longer = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      const diff = end ? new Date(end).getTime() - now.getTime() : Infinity;
      return diff >= 4 * 60 * 60 * 1000;
    });

    // Sort by volume within each category
    const byVol = (a: any, b: any) => (b.volumeNum || 0) - (a.volumeNum || 0);

    const sections = [
      urgent.length
        ? `⚡ ENDING <10 MIN (${urgent.length}):\n${urgent.sort(byVol).slice(0, 20).map(formatMarket).join("\n")}`
        : "",
      nearTerm.length
        ? `🕐 ENDING 10-60 MIN (${nearTerm.length}):\n${nearTerm.sort(byVol).slice(0, 20).map(formatMarket).join("\n")}`
        : "",
      medium.length
        ? `⏳ ENDING 1-4 HOURS (${medium.length}):\n${medium.sort(byVol).slice(0, 15).map(formatMarket).join("\n")}`
        : "",
      longer.sort(byVol).length
        ? `📅 ENDING 4-24+ HOURS (${longer.length}):\n${longer.sort(byVol).slice(0, 10).map(formatMarket).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    console.log(
      `📊 Scanned ${allMarkets.length} unique markets (${urgent.length} urgent, ${nearTerm.length} near, ${medium.length} medium, ${longer.length} longer)`,
    );

    return {
      text: `POLYMARKET ALL CRYPTO MARKETS (${allMarkets.length} total):\n${sections || "No active markets found."}`,
      marketsMap,
    };
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return { text: "POLYMARKET: fetch error", marketsMap: {} };
  }
}

function buildFallbackHypos(marketsMap: Record<string, any>, bankroll: number, liveTrading: boolean) {
  const keywords = ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "dogecoin", "crypto"];
  const entries = Object.entries(marketsMap)
    .map(([market, meta]) => ({ market, ...(meta || {}) }))
    .filter((m: any) => {
      const q = (m.market || "").toLowerCase();
      const hasKeyword = keywords.some((k) => q.includes(k));
      const hasTokens = !!m.clobTokenIds;
      const hasLiquidity = Number(m.volumeNum || 0) > 10000 || Number(m.liquidityNum || 0) > 5000;
      return hasKeyword && hasTokens && hasLiquidity;
    })
    .slice(0, 5);

  const hypos: any[] = [];
  const baseSize = liveTrading ? Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * 0.04) : Math.max(1, bankroll * 0.05);

  for (const m of entries.slice(0, 3)) {
    let prices: number[] = [];
    try {
      const raw = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      prices = Array.isArray(raw) ? raw.map((x: any) => Number(x)) : [];
    } catch {}
    const yesPx = Number.isFinite(prices[0]) ? prices[0] : 0.5;
    const noPx = Number.isFinite(prices[1]) ? prices[1] : 1 - yesPx;
    const action = yesPx <= 0.45 ? "BUY" : "SELL";
    const price = action === "BUY" ? yesPx : noPx;

    hypos.push({
      market: m.market,
      action,
      size: Number(baseSize.toFixed(2)),
      pnl: 0,
      price: Math.max(0.01, Math.min(0.99, Number(price.toFixed(3)))),
      edge: 0.1,
      kelly_f: 0.05,
    });
  }

  return hypos;
}

async function guardRiskLimits(sb: any, bankroll: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: openBets }, { data: dailyBets }, { data: resolvedBets }, { data: recentResolved }] = await Promise.all([
    sb
      .from("bets")
      .select("id,size", { count: "exact" })
      .eq("is_live", true)
      .eq("status", "pending")
      .eq("execution_status", "pending"),
    sb
      .from("bets")
      .select("size")
      .eq("is_live", true)
      .gte("created_at", since)
      .in("execution_status", ["pending", "filled"]),
    sb.from("bets").select("pnl").eq("is_live", true).gte("resolved_at", since).not("pnl", "is", null),
    sb
      .from("bets")
      .select("pnl,resolved_at")
      .eq("is_live", true)
      .not("pnl", "is", null)
      .order("resolved_at", { ascending: false })
      .limit(8),
  ]);

  const openCount = Number(openBets?.length || 0);
  const openPendingRisk = (openBets || []).reduce((s: number, b: any) => s + Number(b.size || 0), 0);
  const dailyRisk = (dailyBets || []).reduce((s: number, b: any) => s + Number(b.size || 0), 0);
  const dailyLoss = (resolvedBets || []).reduce((s: number, b: any) => s + Number(b.pnl || 0), 0);
  const dynamicDailyRiskCap = Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * MAX_DAILY_RISK_PCT);
  const effectiveDailyRiskCap = Math.min(MAX_DAILY_LIVE_RISK_USD, dynamicDailyRiskCap);
  const dynamicDailyLossLimit = -Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * MAX_DAILY_LOSS_PCT);
  const effectiveDailyLossLimit = Math.max(MAX_DAILY_LOSS_USD, dynamicDailyLossLimit);
  const openPendingRiskCap = Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * MAX_OPEN_PENDING_RISK_PCT);

  let lossStreak = 0;
  for (const row of recentResolved || []) {
    if (Number(row.pnl || 0) < 0) lossStreak += 1;
    else break;
  }
  const latestResolvedAt = recentResolved?.[0]?.resolved_at ? new Date(recentResolved[0].resolved_at).getTime() : 0;
  const minsSinceLatestResolution = latestResolvedAt ? Math.round((Date.now() - latestResolvedAt) / 60000) : Infinity;

  if (openCount >= MAX_OPEN_LIVE_BETS) {
    return { blocked: true, reason: `Open bet cap reached (${openCount}/${MAX_OPEN_LIVE_BETS})` };
  }
  if (openPendingRisk >= openPendingRiskCap) {
    return {
      blocked: true,
      reason: `Open pending risk cap reached ($${openPendingRisk.toFixed(2)}/$${openPendingRiskCap.toFixed(2)})`,
    };
  }
  if (dailyRisk >= effectiveDailyRiskCap) {
    return { blocked: true, reason: `Daily risk cap reached ($${dailyRisk.toFixed(2)}/$${effectiveDailyRiskCap.toFixed(2)})` };
  }
  if (dailyLoss <= effectiveDailyLossLimit) {
    return { blocked: true, reason: `Daily loss limit hit ($${dailyLoss.toFixed(2)})` };
  }
  if (lossStreak >= MAX_CONSECUTIVE_LOSSES && minsSinceLatestResolution < LOSS_STREAK_COOLDOWN_MINUTES) {
    return {
      blocked: true,
      reason: `Loss streak cooldown (${lossStreak} losses, ${LOSS_STREAK_COOLDOWN_MINUTES - minsSinceLatestResolution}m remaining)`,
    };
  }

  return { blocked: false, openCount, openPendingRisk, dailyRisk, dailyLoss, lossStreak };
}

async function reconcilePendingBets(sb: any, supabaseUrl: string, supabaseKey: string) {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: pending } = await sb
    .from("bets")
    .select("id,token_id,side,market,created_at")
    .eq("is_live", true)
    .eq("status", "pending")
    .eq("execution_status", "pending")
    .gte("created_at", since)
    .limit(200);

  if (!pending || pending.length === 0) return { confirmed: 0, expired: 0 };

  const tradeResp = await fetch(`${supabaseUrl}/functions/v1/polymarket-trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "get-trades" }),
  });
  if (!tradeResp.ok) return { confirmed: 0, expired: 0 };
  const tradesData = await tradeResp.json();
  const trades: any[] = Array.isArray(tradesData?.data) ? tradesData.data : [];
  if (trades.length === 0) {
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stale = pending.filter((b: any) => b.created_at && b.created_at < staleCutoff).map((b: any) => b.id);
    if (stale.length > 0) {
      await sb
        .from("bets")
        .update({
          status: "expired",
          execution_status: "failed",
          execution_error: "not_confirmed_within_10m",
          updated_at: new Date().toISOString(),
        })
        .in("id", stale);
    }
    return { confirmed: 0, expired: stale.length };
  }

  const matchedIds = new Set<string>();
  for (const t of trades) {
    const asset = (t.asset_id || "").toString();
    const side = (t.side || "").toString().toUpperCase();
    const match = pending.find(
      (b: any) =>
        (b.token_id && b.token_id.toString() === asset) ||
        ((b.market || "").toLowerCase() === (t.market_title || "").toLowerCase() && (b.side || "").toUpperCase() === side),
    );
    if (match) matchedIds.add(match.id);
  }

  if (matchedIds.size === 0) return { confirmed: 0, expired: 0 };

  await sb
    .from("bets")
    .update({ execution_status: "filled", updated_at: new Date().toISOString() })
    .in("id", Array.from(matchedIds));

  return { confirmed: matchedIds.size, expired: 0 };
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

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseTokenIds(rawIds: unknown): string[] {
  if (!rawIds) return [];
  if (Array.isArray(rawIds)) return rawIds.map((x) => x?.toString()).filter(Boolean);
  if (typeof rawIds === "string") {
    try {
      const parsed = JSON.parse(rawIds);
      if (Array.isArray(parsed)) return parsed.map((x) => x?.toString()).filter(Boolean);
    } catch {}
  }
  return [];
}

function computeKellyFraction(edge: number, entryPrice: number): number {
  if (!Number.isFinite(edge) || !Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) return 0;
  const p = clamp(entryPrice + edge, 0.01, 0.99);
  const q = 1 - p;
  const b = (1 - entryPrice) / entryPrice;
  if (b <= 0) return 0;
  const k = (p * b - q) / b;
  return Number.isFinite(k) && k > 0 ? k : 0;
}

function getMinutesToEnd(endDate?: string | null): number | null {
  if (!endDate) return null;
  const ms = new Date(endDate).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 60000);
}

function getOutcomePriceForSide(meta: any, side: "BUY" | "SELL"): number | null {
  try {
    const raw = typeof meta?.outcomePrices === "string" ? JSON.parse(meta.outcomePrices) : meta?.outcomePrices;
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const yesPrice = toNumber(raw[0], NaN);
    const noPrice = toNumber(raw[1], NaN);
    if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) return null;
    return side === "BUY" ? yesPrice : noPrice;
  } catch {
    return null;
  }
}

async function loadExposureContext(sb: any): Promise<ExposureContext> {
  const context: ExposureContext = { marketRiskUsd: {}, tokenRiskUsd: {}, recentMarketTs: {} };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("bets")
    .select("market,token_id,size,created_at,status,execution_status")
    .eq("is_live", true)
    .gte("created_at", since)
    .in("execution_status", ["pending", "filled"])
    .in("status", ["pending", "filled"])
    .limit(800);

  for (const row of data || []) {
    const market = (row.market || "").toString();
    const tokenId = (row.token_id || "").toString();
    const size = Math.max(0, toNumber(row.size, 0));
    const ts = new Date(row.created_at || 0).getTime();

    if (market) {
      context.marketRiskUsd[market] = (context.marketRiskUsd[market] || 0) + size;
      if (!context.recentMarketTs[market] || ts > context.recentMarketTs[market]) {
        context.recentMarketTs[market] = ts;
      }
    }
    if (tokenId) {
      context.tokenRiskUsd[tokenId] = (context.tokenRiskUsd[tokenId] || 0) + size;
    }
  }

  return context;
}

function normalizeAndRankHypos(
  hypos: any[],
  marketsMap: Record<string, any>,
  bankroll: number,
  liveTrading: boolean,
  exposure: ExposureContext,
): any[] {
  const dedupe = new Set<string>();
  const normalized: any[] = [];
  const now = Date.now();

  for (const raw of hypos || []) {
    const market = (raw?.market || "").toString().trim();
    if (!market) continue;
    const meta = marketsMap[market] || {};
    const tokenIds = parseTokenIds(raw?.clobTokenIds || meta?.clobTokenIds);
    if (!meta || tokenIds.length === 0) continue;

    const actionRaw = (raw?.action || raw?.side || "BUY").toString().toUpperCase();
    const action = actionRaw === "SELL" || actionRaw === "BUY_NO" ? "SELL" : "BUY";
    const tokenId = action === "BUY" ? tokenIds[0] : tokenIds[1] || tokenIds[0];
    const key = `${market}::${action}::${tokenId}`;
    if (dedupe.has(key)) continue;

    const marketRisk = toNumber(exposure.marketRiskUsd[market], 0);
    const tokenRisk = toNumber(exposure.tokenRiskUsd[tokenId], 0);
    const recentTs = toNumber(exposure.recentMarketTs[market], 0);
    if (liveTrading) {
      if (marketRisk >= MAX_PER_MARKET_LIVE_RISK_USD) continue;
      if (tokenRisk >= MAX_PER_TOKEN_LIVE_RISK_USD) continue;
      if (recentTs > 0 && now - recentTs < MARKET_COOLDOWN_MINUTES * 60 * 1000) continue;
    }

    const volume = toNumber(meta.volumeNum);
    const liquidity = toNumber(meta.liquidityNum);
    if (volume < MIN_VOLUME_TO_TRADE && liquidity < MIN_LIQUIDITY_TO_TRADE) continue;

    const minsToEnd = getMinutesToEnd(meta.endDate);
    if (minsToEnd !== null && (minsToEnd <= 0 || minsToEnd > MAX_MARKET_MINUTES)) continue;

    const edge = toNumber(raw?.edge ?? raw?.confidence, 0);
    if (liveTrading && edge < MIN_EDGE_TO_TRADE) continue;

    const metaPrice = getOutcomePriceForSide(meta, action as "BUY" | "SELL");
    const modelPrice = toNumber(raw?.price, NaN);
    const referencePrice = Number.isFinite(modelPrice) ? modelPrice : metaPrice;
    if (!Number.isFinite(referencePrice)) continue;
    if (referencePrice! < MIN_ODDS_TO_TRADE || referencePrice! > MAX_ODDS_TO_TRADE) continue;

    const computedKelly = computeKellyFraction(edge, referencePrice!);
    const modelKelly = toNumber(raw?.kelly_f, NaN);
    const baseKelly = Number.isFinite(modelKelly) && modelKelly > 0 ? Math.min(modelKelly, computedKelly || modelKelly) : computedKelly;
    const fractionalKelly = clamp(baseKelly * KELLY_FRACTION, 0, MAX_KELLY_FRACTION_PER_TRADE);
    if (liveTrading && fractionalKelly <= 0) continue;

    let sizeByKelly = bankroll * Math.max(MIN_KELLY_FRACTION_PER_TRADE, fractionalKelly);
    if (minsToEnd !== null && minsToEnd <= 15) {
      sizeByKelly *= URGENT_MARKET_SIZE_MULTIPLIER;
    }

    const rawSize = toNumber(raw?.size, sizeByKelly);
    const proposedSize = liveTrading ? Math.min(rawSize, sizeByKelly * 1.25) : rawSize;
    const minSize = liveTrading ? MIN_LIVE_TRADE_SIZE_USD : 1;
    const maxSize = liveTrading ? Math.max(minSize, bankroll * MAX_TRADE_SIZE_PCT) : Math.max(1, bankroll * 0.15);
    const marketCapUsd = liveTrading ? Math.min(MAX_PER_MARKET_LIVE_RISK_USD, bankroll * MAX_MARKET_EXPOSURE_PCT) : maxSize;
    const tokenCapUsd = liveTrading ? Math.min(MAX_PER_TOKEN_LIVE_RISK_USD, bankroll * MAX_TOKEN_EXPOSURE_PCT) : maxSize;
    const marketCapRemaining = liveTrading ? Math.max(0, marketCapUsd - marketRisk) : maxSize;
    const tokenCapRemaining = liveTrading ? Math.max(0, tokenCapUsd - tokenRisk) : maxSize;
    const riskCap = liveTrading ? Math.min(maxSize, marketCapRemaining, tokenCapRemaining) : maxSize;
    if (liveTrading && riskCap < minSize) continue;
    const size = clamp(proposedSize, minSize, riskCap);

    const expectedValueUsd = size * edge;
    if (liveTrading && expectedValueUsd < MIN_EXPECTED_VALUE_USD) continue;

    const urgencyScore = minsToEnd === null ? 0 : minsToEnd <= 15 ? 4 : minsToEnd <= 60 ? 2 : 1;
    const liquidityScore = Math.min(4, Math.log10(Math.max(10, liquidity)) - 3);
    const volumeScore = Math.min(4, Math.log10(Math.max(10, volume)) - 3);
    const concentrationPenalty = liveTrading ? Math.min(8, (marketRisk + tokenRisk) * 0.1) : 0;
    const score =
      edge * 100 + urgencyScore + liquidityScore + volumeScore + Math.min(10, expectedValueUsd) + fractionalKelly * 30 - concentrationPenalty;

    dedupe.add(key);
    normalized.push({
      ...raw,
      market,
      action,
      clobTokenIds: tokenIds,
      tokenId,
      edge,
      price: Number(referencePrice!.toFixed(3)),
      size: Number(size.toFixed(2)),
      kelly_f: Number(fractionalKelly.toFixed(4)),
      _score: score,
      _minsToEnd: minsToEnd,
      _volume: volume,
      _liquidity: liquidity,
      _expectedValue: expectedValueUsd,
    });
  }

  normalized.sort((a, b) => b._score - a._score);
  return normalized.slice(0, MAX_TRADES_PER_CYCLE);
}

// Execute a single trade by calling the polymarket-trade edge function
async function executeTrade(
  supabaseUrl: string,
  supabaseKey: string,
  hypo: any,
  marketsMap: Record<string, any>,
): Promise<TradeExecResult> {
  const meta = marketsMap[hypo.market] || {};
  let tokenIds: string[] = parseTokenIds(hypo.clobTokenIds || meta.clobTokenIds);

  // If no token IDs from market data, try fetching from Gamma API
  if (tokenIds.length === 0) {
    const conditionId = hypo.condition_id || meta.conditionId;
    if (conditionId) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
        if (res.ok) {
          const markets = await res.json();
          if (markets[0]?.clobTokenIds) {
            const ids = parseTokenIds(markets[0].clobTokenIds);
            tokenIds = ids;
          }
        }
      } catch {}
    }
  }

  if (tokenIds.length === 0) {
    console.log(`⚠ No token IDs for ${hypo.market}, skipping`);
    return { market: hypo.market, status: "skipped", price: hypo.price || 0.5, error: "no_token_ids" };
  }

  // For SELL/BUY_NO, use the NO token (index 1); for BUY, use YES token (index 0)
  const action = (hypo.action || "BUY").toUpperCase();
  const isSell = action === "SELL" || action === "BUY_NO";
  const tokenId = isSell ? tokenIds[1] || tokenIds[0] : tokenIds[0];
  const tradeSide = isSell ? "SELL" : "BUY";

  // Prefer model/fallback price first for speed; fetch midpoint only if invalid.
  let referencePrice = Number(hypo.price || NaN);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || referencePrice >= 1) {
    referencePrice = getOutcomePriceForSide(meta, tradeSide as "BUY" | "SELL") ?? NaN;
  }
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || referencePrice >= 1) {
    referencePrice = 0.5;
    try {
      const midRes = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
      if (midRes.ok) {
        const midData = await midRes.json();
        if (midData.mid) referencePrice = parseFloat(midData.mid);
      }
    } catch {}
  }
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || referencePrice >= 1) {
    return { market: hypo.market, tokenId, side: tradeSide, status: "skipped", price: 0.5, error: "invalid_reference_price" };
  }

  const edge = toNumber(hypo.edge, MIN_EDGE_TO_TRADE);
  const minsToEnd = getMinutesToEnd(meta.endDate);
  const urgencyBoost = minsToEnd !== null && minsToEnd <= 15 ? 1.2 : minsToEnd !== null && minsToEnd > 90 ? 0.8 : 1;
  const edgeBoost = edge >= 0.12 ? 1.15 : edge >= 0.08 ? 1.0 : 0.85;
  const aggression = clamp(PRICE_CROSS_AGGRESSION * urgencyBoost * edgeBoost, 0.01, MAX_PRICE_DRIFT);

  let crossedPrice = tradeSide === "BUY" ? referencePrice + aggression : referencePrice - aggression;
  if (Math.abs(crossedPrice - referencePrice) > MAX_PRICE_DRIFT) {
    crossedPrice = referencePrice + Math.sign(crossedPrice - referencePrice) * MAX_PRICE_DRIFT;
  }
  const price = Math.max(0.01, Math.min(0.99, Number(crossedPrice.toFixed(3))));

  const requestedSize = Number(hypo.size || 0);
  const finalSize = Math.max(MIN_LIVE_TRADE_SIZE_USD, Number.isFinite(requestedSize) ? requestedSize : MIN_LIVE_TRADE_SIZE_USD);
  console.log(
    `🔄 Executing: ${tradeSide} ${finalSize} of ${hypo.market} @ $${price.toFixed(3)} (ref $${referencePrice.toFixed(3)})`,
  );

  const extractResult = (statusCode: number, result: any, fallbackPrice: number): TradeExecResult | null => {
    const orderID = result?.orderId || result?.orderID || result?.result?.orderID || result?.result?.orderId || null;
    const rawStatus = (result?.result?.status || result?.status || "").toString().toLowerCase();
    const submitted = !!(result?.submitted || result?.success || result?.result?.success || orderID);
    if (!submitted) return null;
    const filledStates = new Set(["matched", "filled", "mined", "confirmed"]);
    const status: TradeExecResult["status"] = filledStates.has(rawStatus) ? "filled" : "pending";
    return {
      market: hypo.market,
      tokenId,
      side: tradeSide,
      size: finalSize,
      status,
      price: Number(result?.finalPrice || result?.result?.finalPrice || fallbackPrice),
      orderID: orderID || undefined,
      relayStatus: statusCode,
    };
  };

  const callEdge = async (path: string, payload: any) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRADE_TIMEOUT_MS);
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
          apikey: supabaseKey,
        },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text || "invalid_json_response" };
      }
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    // Primary path: place-trade (proven working execution route)
    const primary = await callEdge("polymarket-trade", {
      action: "place-trade",
      tokenId,
      side: tradeSide,
      size: finalSize,
      price,
    });
    const primaryParsed = extractResult(primary.status, primary.json, price);
    if (primary.ok && primaryParsed) {
      console.log(`✅ Place-trade ${primaryParsed.status}: ${tradeSide} ${finalSize} @ $${primaryParsed.price}`);
      return primaryParsed;
    }

    // Fallback path: execute-trade relay wrapper
    for (let attempt = 1; attempt <= 2; attempt++) {
      const fallback = await callEdge("execute-trade", {
        tokenId,
        side: tradeSide,
        size: finalSize,
        price,
      });
      const fallbackParsed = extractResult(fallback.status, fallback.json, price);
      if (fallback.ok && fallbackParsed) {
        console.log(`✅ Execute-trade ${fallbackParsed.status}: ${tradeSide} ${finalSize} @ $${fallbackParsed.price}`);
        return fallbackParsed;
      }

      const err = (fallback.json?.error || "").toString().toLowerCase();
      const transient = fallback.status >= 500 || err.includes("timeout") || err.includes("temporar");
      if (attempt < 2 && transient) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      return {
        market: hypo.market,
        tokenId,
        side: tradeSide,
        size: finalSize,
        status: "failed",
        price,
        error: fallback.json?.error || `submission_failed_${fallback.status}`,
        relayStatus: fallback.status,
      };
    }

    return { market: hypo.market, tokenId, side: tradeSide, size: finalSize, status: "failed", price, error: "retry_exhausted" };
  } catch (e) {
    return {
      market: hypo.market,
      tokenId,
      side: tradeSide,
      size: finalSize,
      status: "failed",
      price,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeTradesFast(
  supabaseUrl: string,
  supabaseKey: string,
  hypos: any[],
  marketsMap: Record<string, any>,
): Promise<TradeExecResult[]> {
  const maxConcurrent = Math.max(1, MAX_CONCURRENT_TRADES);
  const queue = hypos.slice(0, MAX_TRADES_PER_CYCLE);
  const results: TradeExecResult[] = [];

  for (let i = 0; i < queue.length; i += maxConcurrent) {
    const batch = queue.slice(i, i + maxConcurrent);
    const settled = await Promise.all(
      batch.map(async (hypo) => await executeTrade(supabaseUrl, supabaseKey, hypo, marketsMap)),
    );
    results.push(...settled);

    const executed = results.filter((r) => r.status !== "skipped");
    const failures = executed.filter((r) => r.status === "failed").length;
    if (executed.length >= 3 && failures / executed.length >= FAILURE_CIRCUIT_BREAKER_RATIO) {
      console.error(`🛑 Circuit breaker: ${failures}/${executed.length} failures`);
      break;
    }
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const cycle = body.cycle || 1;
    const bankroll = toNumber(body.bankroll, 18);
    const systemPrompt = body.systemPrompt || "Find high-quality positive-EV trades ending soon while controlling downside risk.";
    const liveTrading = body.liveTrading ?? true;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    const reconciled = await reconcilePendingBets(sb, supabaseUrl, supabaseKey);
    if (reconciled.confirmed > 0) {
      console.log(`✅ Reconciled ${reconciled.confirmed} pending orders as filled`);
    }
    if (reconciled.expired > 0) {
      console.log(`⌛ Expired ${reconciled.expired} stale pending orders`);
    }

    if (liveTrading) {
      const guard = await guardRiskLimits(sb, bankroll);
      if (guard.blocked) {
        return new Response(
          JSON.stringify({
            cycle,
            bankroll,
            hypos: [],
            tradeResults: [],
            error: guard.reason,
            log: `Risk guard blocked cycle: ${guard.reason}`,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const [polyResult, cryptoData] = await Promise.all([fetchPolymarket(), fetchCryptoPrices()]);

    const polyData = polyResult.text;
    const marketsMap = polyResult.marketsMap;

    const userMessage = `Cycle ${cycle}. Bankroll: $${bankroll}.
⚡ LIVE TRADING MODE: Fractional Kelly sizing with risk caps.
Per-trade cap: $${Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * MAX_TRADE_SIZE_PCT).toFixed(2)}. Min edge: ${(MIN_EDGE_TO_TRADE * 100).toFixed(1)}%.

LIVE DATA:
${polyData}
${cryptoData}

${systemPrompt}`;

    console.log(`🚀 Cycle ${cycle} starting (bankroll: $${bankroll}, live: ${liveTrading})`);

    let parsed;
    if (LOVABLE_API_KEY) {
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
              content: `You are a quantitative trading engine for Polymarket focused on positive expectancy and strict risk control. You MUST respond with valid JSON only. No markdown, no code blocks.

KELLY CRITERION STRATEGY (Target: positive expectancy with capital preservation):
1. EDGE DETECTION: Calculate TRUE probability using BTC momentum, news sentiment, whale flows, volume patterns.
   - Edge = TRUE_prob - market_price. Trade when edge > 8% (0.08). Skip weak edges.
   - BTC 24h change is primary signal. Negative → SELL/NO, Positive → BUY/YES.
   - Use time decay: markets ending in <10 min with mispriced odds have HUGE edge.

2. KELLY SIZING: f* = (p*b - q) / b where p=win_prob, q=1-p, b=odds.
   - Use FRACTIONAL Kelly: bet 1-6% of bankroll per trade.
   - Live mode: respect provided size caps and never force oversized bets.

3. MARKET SELECTION:
   - ONLY CRYPTO markets. Ignore ALL non-crypto markets (politics, sports, weather, etc.).
   - ONLY markets ending SOON: <10 min is ideal, <60 min is acceptable. Do NOT trade markets ending in hours.
   - ONLY high-volume markets (volume > $10,000 or liquidity > $5,000).
   - Parse "outcomePrices" as "[YesPrice, NoPrice]". Trade the side priced 0.15-0.75.
   - Output 0-2 hypos. It is acceptable to return 0 when no clear edge exists.

4. RISK FIRST: Prefer fewer, high-conviction setups. Avoid overtrading.

5. OUTPUT each hypo with: "market" (exact question), "action" (BUY/SELL), "size" (dollar amount), "pnl" (0), "price" (entry price), "edge" (estimated edge), "kelly_f" (kelly fraction used).

CRITICAL: ONLY trade CRYPTO markets ending SOON (<60 min). Use EXACT market question in "market" field. Output format: {"cycle":N,"bankroll":N,"hypos":[...],"log":"..."}`,
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

      try {
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch {
        console.error("Failed to parse AI response:", text.slice(0, 500));
        parsed = { cycle, bankroll, hypos: [], log: "AI response parse error: " + text.slice(0, 200) };
      }
    } else {
      const fallbackHypos = buildFallbackHypos(marketsMap, bankroll, liveTrading);
      parsed = {
        cycle,
        bankroll,
        hypos: fallbackHypos,
        log: fallbackHypos.length
          ? `Fallback strategy used (LOVABLE_API_KEY missing): ${fallbackHypos.length} trade ideas`
          : "Fallback strategy found no eligible markets",
      };
    }

    parsed.cycle = parsed.cycle || cycle;
    parsed.bankroll = parsed.bankroll || bankroll;
    parsed.hypos = parsed.hypos || [];
    parsed.log = parsed.log || "Cycle complete";

    const aiCount = parsed.hypos.length;
    console.log(`🤖 AI returned ${aiCount} trade ideas`);

    // Enrich hypos with token IDs from market data
    for (const h of parsed.hypos) {
      const meta = marketsMap[h.market];
      if (meta?.clobTokenIds) {
        h.clobTokenIds = parseTokenIds(meta.clobTokenIds);
      }
      if (meta?.conditionId) h.condition_id = meta.conditionId;
      if (meta?.slug) h.market_slug = meta.slug;
    }

    const exposure = liveTrading ? await loadExposureContext(sb) : { marketRiskUsd: {}, tokenRiskUsd: {}, recentMarketTs: {} };
    const rankedHypos = normalizeAndRankHypos(parsed.hypos, marketsMap, bankroll, liveTrading, exposure);
    const filteredCount = aiCount - rankedHypos.length;
    parsed.hypos = rankedHypos.map(({ _score, _minsToEnd, _volume, _liquidity, ...rest }: any) => rest);
    if (filteredCount > 0) {
      parsed.log += ` | Filtered ${filteredCount} low-quality ideas`;
    }
    console.log(`✅ Using ${parsed.hypos.length} validated trade ideas`);

    // Execute trades and save results
    const tradeResults: any[] = [];

    if (liveTrading && parsed.hypos.length > 0) {
      console.log(`⚡ Executing ${parsed.hypos.length} live trades...`);

      const hyposToExecute = parsed.hypos.slice(0, MAX_TRADES_PER_CYCLE);
      const fastResults = await executeTradesFast(supabaseUrl, supabaseKey, hyposToExecute, marketsMap);
      tradeResults.push(...fastResults);

      for (let i = 0; i < hyposToExecute.length; i++) {
        const hypo = hyposToExecute[i];
        const tradeResult = tradeResults[i] || { status: "failed", price: hypo.price || 0.5, error: "missing_result" };

        // Save bet to database with execution status
        const marketMeta = marketsMap[hypo.market] || {};
        const resolutionStatus = tradeResult.status === "failed" || tradeResult.status === "skipped" ? "expired" : "pending";
        const betData = {
          cycle: parsed.cycle,
          market: hypo.market || "Unknown",
          market_slug: hypo.market_slug || marketMeta.slug || null,
          condition_id: hypo.condition_id || marketMeta.conditionId || null,
          token_id: tradeResult.tokenId || null,
          side: tradeResult.side || hypo.action || "BUY",
          recommended_price: tradeResult.price || hypo.price || 0.5,
          size: tradeResult.size || hypo.size || 0,
          confidence: hypo.edge || hypo.confidence || null,
          is_live: true,
          status: resolutionStatus,
          execution_status: tradeResult.status,
          execution_error: tradeResult.error || null,
          external_order_id: tradeResult.orderID || null,
          relay_status: tradeResult.relayStatus || null,
          executed_at: new Date().toISOString(),
          attempts: 1,
          updated_at: new Date().toISOString(),
        };

        const { error: insertErr } = await sb.from("bets").insert(betData);
        if (insertErr) {
          console.error(`Failed to save bet for ${hypo.market}:`, insertErr);
        }
      }

      const filled = tradeResults.filter((t) => t.status === "filled").length;
      const pending = tradeResults.filter((t) => t.status === "pending").length;
      const failed = tradeResults.filter((t) => t.status === "failed").length;
      const skipped = tradeResults.filter((t) => t.status === "skipped").length;
      console.log(`📊 Results: ${filled} filled, ${pending} pending, ${failed} failed, ${skipped} skipped`);
      parsed.tradeResults = tradeResults;
      parsed.log += ` | Trades: ${filled} filled, ${pending} pending, ${failed} failed`;
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
          execution_status: "simulated",
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
