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
const MIN_LIQUIDITY_TO_TRADE = Number(Deno.env.get("MIN_LIQUIDITY_TO_TRADE") || 20000);
const MIN_VOLUME_TO_TRADE = Number(Deno.env.get("MIN_VOLUME_TO_TRADE") || 25000);
const MIN_ODDS_TO_TRADE = Number(Deno.env.get("MIN_ODDS_TO_TRADE") || 0.08);
const MAX_ODDS_TO_TRADE = Number(Deno.env.get("MAX_ODDS_TO_TRADE") || 0.92);
const MAX_MARKET_MINUTES = Number(Deno.env.get("MAX_MARKET_MINUTES") || 60);
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
const MAX_SPREAD_TO_TRADE = Number(Deno.env.get("MAX_SPREAD_TO_TRADE") || 0.02);
const FEE_BUFFER_RATE = Number(Deno.env.get("FEE_BUFFER_RATE") || 0.01);
const MIN_NET_EDGE_TO_TRADE = Number(Deno.env.get("MIN_NET_EDGE_TO_TRADE") || 0.03);
const MAKER_PRICE_BUFFER_TICKS = Number(Deno.env.get("MAKER_PRICE_BUFFER_TICKS") || 1);
const REQUIRED_MARKET_KEYWORDS = (Deno.env.get("REQUIRED_MARKET_KEYWORDS") || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const MIN_SIGNAL_STRENGTH = Number(Deno.env.get("MIN_SIGNAL_STRENGTH") || 0.02);
const USE_SIGNAL_HYPOS = (Deno.env.get("USE_SIGNAL_HYPOS") || "true").toLowerCase() !== "false";
const MAX_TRUSTED_EDGE = Number(Deno.env.get("MAX_TRUSTED_EDGE") || 0.1);
const SHORT_UPDOWN_BUY_MIN_EDGE = Number(Deno.env.get("SHORT_UPDOWN_BUY_MIN_EDGE") || 0.12);
const SHORT_UPDOWN_BUY_MAX_PRICE = Number(Deno.env.get("SHORT_UPDOWN_BUY_MAX_PRICE") || 0.55);
const DISALLOWED_MARKET_KEYWORDS = (
  Deno.env.get("DISALLOWED_MARKET_KEYWORDS") ||
  Deno.env.get("DISALLOWED_CRYPTO_KEYWORDS") ||
  ""
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const ENABLE_AUTO_EXITS = (Deno.env.get("ENABLE_AUTO_EXITS") || "true").toLowerCase() !== "false";
const STOP_LOSS_RETURN_PCT = Number(Deno.env.get("STOP_LOSS_RETURN_PCT") || 0.35);
const TAKE_PROFIT_RETURN_PCT = Number(Deno.env.get("TAKE_PROFIT_RETURN_PCT") || 0.25);
const MAX_EXIT_ORDERS_PER_CYCLE = Number(Deno.env.get("MAX_EXIT_ORDERS_PER_CYCLE") || 2);
const MIN_EXIT_POSITION_SHARES = Number(Deno.env.get("MIN_EXIT_POSITION_SHARES") || 1);
const MIN_EXIT_NOTIONAL_USD = Number(Deno.env.get("MIN_EXIT_NOTIONAL_USD") || 0.5);
const STOP_LOSS_ORDER_TYPE = (Deno.env.get("STOP_LOSS_ORDER_TYPE") || "FAK").toUpperCase();
const TAKE_PROFIT_ORDER_TYPE = (Deno.env.get("TAKE_PROFIT_ORDER_TYPE") || "FAK").toUpperCase();
// One-time reset to ignore polluted live bet history before the post-fix deployment.
const DEFAULT_RISK_RESET_AT = "2026-03-06T11:00:00Z";

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
  notionalUsd?: number;
  reason?: string;
}

interface ExposureContext {
  marketRiskUsd: Record<string, number>;
  tokenRiskUsd: Record<string, number>;
  recentMarketTs: Record<string, number>;
}

interface PositionSnapshot {
  tokenId: string;
  market: string;
  marketSlug: string | null;
  conditionId: string | null;
  sizeShares: number;
  avgPrice: number;
  currentPrice: number;
  notionalUsd: number;
  pnlUsd: number;
  returnPct: number;
  outcomeIndex: number | null;
  redeemable: boolean;
}

async function fetchPolymarket(): Promise<{ text: string; marketsMap: Record<string, any> }> {
  try {
    const now = new Date();
    const endMin = now.toISOString();
    const soon10 = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const soon60 = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    // Fetch all active markets ending within the next hour, plus liquid leaders for metadata enrichment.
    const queries = [
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${endMin}&end_date_max=${soon10}`,
      ),
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${soon10}&end_date_max=${soon60}`,
      ),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false`),
      fetch(
        `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=liquidityNum&ascending=false`,
      ),
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

    const eligibleMarkets = allMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      if (!end) return false;
      const diff = new Date(end).getTime() - now.getTime();
      return Number.isFinite(diff) && diff > 0 && diff <= MAX_MARKET_MINUTES * 60 * 1000;
    });

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
        bestBid: Number(m.bestBid ?? NaN),
        bestAsk: Number(m.bestAsk ?? NaN),
        spread: Number(m.spread ?? NaN),
        feesEnabled: Boolean(m.feesEnabled),
        orderMinSize: Number(m.orderMinSize || 0),
        minimumTickSize: Number(m.orderPriceMinTickSize || 0.01),
        lastTradePrice: Number(m.lastTradePrice ?? NaN),
        oneHourPriceChange: Number(m.oneHourPriceChange ?? 0),
        oneDayPriceChange: Number(m.oneDayPriceChange ?? 0),
      };
      return `${m.question} | conditionId: ${m.conditionId || "?"} | price: ${m.outcomePrices} | vol: $${Math.round(m.volumeNum || 0)} | liq: $${Math.round(m.liquidityNum || 0)} | ENDS IN: ${minsLeft} min`;
    };

    const urgent = eligibleMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      return end && new Date(end).getTime() - now.getTime() < 10 * 60 * 1000;
    });
    const nearTerm = eligibleMarkets.filter((m) => {
      const end = m.endDate || m.end_date_iso;
      const diff = end ? new Date(end).getTime() - now.getTime() : Infinity;
      return diff >= 10 * 60 * 1000 && diff < 60 * 60 * 1000;
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
    ]
      .filter(Boolean)
      .join("\n\n");

    console.log(
      `📊 Scanned ${eligibleMarkets.length} eligible markets <= ${MAX_MARKET_MINUTES} min (${urgent.length} urgent, ${nearTerm.length} near)`,
    );

    return {
      text: `POLYMARKET MARKETS ENDING <= ${MAX_MARKET_MINUTES} MIN (${eligibleMarkets.length} total):\n${sections || "No active markets found."}`,
      marketsMap,
    };
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return { text: "POLYMARKET: fetch error", marketsMap: {} };
  }
}

function buildFallbackHypos(marketsMap: Record<string, any>, bankroll: number, liveTrading: boolean) {
  return buildSignalHypos(marketsMap, bankroll, liveTrading);
}

function buildSignalHypos(marketsMap: Record<string, any>, bankroll: number, liveTrading: boolean): any[] {
  const candidates: any[] = [];
  const baseSize = liveTrading ? Math.max(MIN_LIVE_TRADE_SIZE_USD, bankroll * 0.03) : Math.max(1, bankroll * 0.05);

  for (const [market, meta] of Object.entries(marketsMap)) {
    if (!isAllowedMarket(market)) continue;
    const tokenIds = parseTokenIds(meta?.clobTokenIds);
    if (tokenIds.length === 0) continue;

    const volume = toNumber(meta?.volumeNum, 0);
    const liquidity = toNumber(meta?.liquidityNum, 0);
    if (volume < MIN_VOLUME_TO_TRADE && liquidity < MIN_LIQUIDITY_TO_TRADE) continue;

    const minsToEnd = getMinutesToEnd(meta?.endDate);
    if (minsToEnd !== null && (minsToEnd <= 0 || minsToEnd > MAX_MARKET_MINUTES)) continue;

    const yesPrice = getOutcomePriceForSide(meta, "BUY");
    const noPrice = getOutcomePriceForSide(meta, "SELL");
    const spread = getMarketSpread(meta);
    if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;
    if (spread !== null && spread > MAX_SPREAD_TO_TRADE) continue;

    const momentum1h = toNumber(meta?.oneHourPriceChange, 0);
    const momentum1d = toNumber(meta?.oneDayPriceChange, 0);
    const signalStrength = Math.abs(momentum1h) * 0.75 + Math.abs(momentum1d) * 0.25;
    if (signalStrength < MIN_SIGNAL_STRENGTH) continue;

    const action = momentum1h >= 0 ? "BUY" : "SELL";
    const referencePrice = action === "BUY" ? yesPrice : noPrice;
    if (referencePrice < MIN_ODDS_TO_TRADE || referencePrice > MAX_ODDS_TO_TRADE) continue;

    const signalEdge = Math.min(0.18, signalStrength * 1.75);
    const netEdge = signalEdge - estimateExecutionCost(meta);
    if (netEdge < MIN_NET_EDGE_TO_TRADE) continue;

    candidates.push({
      market,
      action,
      size: Number(baseSize.toFixed(2)),
      pnl: 0,
      price: Number(referencePrice.toFixed(3)),
      edge: Number(signalEdge.toFixed(4)),
      kelly_f: 0.04,
      source: "signals",
    });
  }

  return candidates.sort((a, b) => b.edge - a.edge).slice(0, Math.max(2, MAX_TRADES_PER_CYCLE));
}

async function guardRiskLimits(sb: any, bankroll: number) {
  const since = getRiskWindowStartIso();

  const [{ data: openBets }, { data: dailyBets }, { data: resolvedBets }, { data: recentResolved }] = await Promise.all(
    [
      sb.from("bets").select("*", { count: "exact" }).eq("is_live", true).eq("status", "pending"),
      sb.from("bets").select("*").eq("is_live", true).gte("created_at", since).limit(400),
      sb.from("bets").select("pnl,resolved_at").eq("is_live", true).gte("resolved_at", since).not("pnl", "is", null),
      sb
        .from("bets")
        .select("pnl,resolved_at")
        .eq("is_live", true)
        .not("pnl", "is", null)
        .gte("resolved_at", since)
        .order("resolved_at", { ascending: false })
        .limit(8),
    ],
  );

  const isTrackedOpen = (b: any) => {
    const executionStatus = (b.execution_status || "").toString().toLowerCase();
    const status = (b.status || "").toString().toLowerCase();
    return executionStatus
      ? ["pending", "filled"].includes(executionStatus) && status === "pending"
      : status === "pending";
  };
  const isTrackedDaily = (b: any) => {
    const executionStatus = (b.execution_status || "").toString().toLowerCase();
    const status = (b.status || "").toString().toLowerCase();
    if (status === "expired") return false;
    return executionStatus
      ? ["pending", "filled"].includes(executionStatus)
      : ["pending", "won", "lost"].includes(status);
  };
  const costBasis = (b: any) => Math.max(0, toNumber(b.size, 0) * Math.max(0.01, toNumber(b.recommended_price, 0.5)));

  const normalizedOpen = (openBets || []).filter(isTrackedOpen);
  const normalizedDaily = (dailyBets || []).filter(isTrackedDaily);
  const openCount = Number(normalizedOpen.length || 0);
  const openPendingRisk = normalizedOpen.reduce((s: number, b: any) => s + costBasis(b), 0);
  const dailyRisk = normalizedDaily.reduce((s: number, b: any) => s + costBasis(b), 0);
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
    return {
      blocked: true,
      reason: `Daily risk cap reached ($${dailyRisk.toFixed(2)}/$${effectiveDailyRiskCap.toFixed(2)})`,
    };
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
    .select("*")
    .eq("is_live", true)
    .eq("status", "pending")
    .gte("created_at", since)
    .limit(200);

  const trackedPending = (pending || []).filter((b: any) => {
    const executionStatus = (b.execution_status || "").toString().toLowerCase();
    return !executionStatus || executionStatus === "pending";
  });

  if (trackedPending.length === 0) return { confirmed: 0, expired: 0 };

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
    const stale = trackedPending.filter((b: any) => b.created_at && b.created_at < staleCutoff).map((b: any) => b.id);
    if (stale.length > 0) {
      await updateBetsSafe(sb, stale, {
        status: "expired",
        execution_status: "failed",
        execution_error: "not_confirmed_within_10m",
        updated_at: new Date().toISOString(),
      });
    }
    return { confirmed: 0, expired: stale.length };
  }

  const matchedIds = new Set<string>();
  for (const t of trades) {
    const asset = (t.asset_id || "").toString();
    const side = (t.side || "").toString().toUpperCase();
    const match = trackedPending.find(
      (b: any) =>
        (b.token_id && b.token_id.toString() === asset) ||
        ((b.market || "").toLowerCase() === (t.market_title || "").toLowerCase() &&
          (b.side || "").toUpperCase() === side),
    );
    if (match) matchedIds.add(match.id);
  }

  if (matchedIds.size === 0) return { confirmed: 0, expired: 0 };

  await updateBetsSafe(sb, Array.from(matchedIds), {
    execution_status: "filled",
    updated_at: new Date().toISOString(),
  });

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

function firstFiniteNumber(values: unknown[], fallback = NaN): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseIsoTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function getRiskWindowStartIso(hours = 24): string {
  const fallbackTs = Date.now() - hours * 60 * 60 * 1000;
  const configuredResetTs =
    parseIsoTimestamp(Deno.env.get("RISK_RESET_AT")) ?? parseIsoTimestamp(DEFAULT_RISK_RESET_AT);
  const startTs = configuredResetTs ? Math.max(fallbackTs, configuredResetTs) : fallbackTs;
  return new Date(startTs).toISOString();
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

function isAllowedMarket(market: string): boolean {
  const normalized = market.toLowerCase();
  if (DISALLOWED_MARKET_KEYWORDS.some((keyword) => normalized.includes(keyword))) return false;
  return (
    REQUIRED_MARKET_KEYWORDS.length === 0 || REQUIRED_MARKET_KEYWORDS.some((keyword) => normalized.includes(keyword))
  );
}

function isShortUpDownMarket(market: string, minsToEnd: number | null): boolean {
  const normalized = market.toLowerCase();
  if (!normalized.includes("up or down")) return false;
  return minsToEnd === null || minsToEnd <= 60;
}

function getMarketSpread(meta: any): number | null {
  const direct = toNumber(meta?.spread, NaN);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const bestBid = toNumber(meta?.bestBid, NaN);
  const bestAsk = toNumber(meta?.bestAsk, NaN);
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk > bestBid) {
    return Number((bestAsk - bestBid).toFixed(4));
  }
  return null;
}

function estimateExecutionCost(meta: any): number {
  const spread = getMarketSpread(meta) ?? 0;
  const tick = Math.max(0.001, toNumber(meta?.minimumTickSize, 0.01));
  const feeBuffer = meta?.feesEnabled ? FEE_BUFFER_RATE : 0;
  return Number((spread + tick + feeBuffer).toFixed(4));
}

function getMakerLimitPrice(meta: any, action: "BUY" | "SELL", referencePrice: number): number {
  const bestBid = toNumber(meta?.bestBid, NaN);
  const bestAsk = toNumber(meta?.bestAsk, NaN);
  const tick = Math.max(0.001, toNumber(meta?.minimumTickSize, 0.01));
  const tickBuffer = tick * MAKER_PRICE_BUFFER_TICKS;

  if (action === "BUY") {
    if (Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestAsk > bestBid) {
      const makerMax = Math.max(tick, bestAsk - tickBuffer);
      return clamp(Math.min(referencePrice, makerMax), tick, makerMax);
    }
    if (Number.isFinite(bestBid)) {
      return clamp(bestBid, tick, 1 - tick);
    }
  }

  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk > bestBid) {
    const makerMin = Math.min(1 - tick, bestBid + tickBuffer);
    return clamp(Math.max(referencePrice, makerMin), makerMin, 1 - tick);
  }
  if (Number.isFinite(bestAsk)) {
    return clamp(bestAsk, tick, 1 - tick);
  }

  return clamp(referencePrice, tick, 1 - tick);
}

function getAggressiveExitPrice(meta: any, referencePrice: number): number {
  const tick = Math.max(0.001, toNumber(meta?.minimumTickSize, 0.01));
  const bestBid = toNumber(meta?.bestBid, NaN);
  if (Number.isFinite(bestBid) && bestBid > 0) {
    return clamp(bestBid, tick, 1 - tick);
  }
  return clamp(referencePrice, tick, 1 - tick);
}

function normalizePosition(row: any): PositionSnapshot | null {
  const tokenId = (row?.asset || row?.token_id || "").toString();
  const market = (row?.title || row?.market || "").toString();
  const sizeShares = toNumber(row?.size, 0);
  const avgPrice = firstFiniteNumber([row?.avgPrice, row?.avg_price], NaN);
  const currentPrice = firstFiniteNumber([row?.curPrice, row?.cur_price, row?.currentPrice, row?.price], avgPrice);
  if (
    !tokenId ||
    !market ||
    !Number.isFinite(sizeShares) ||
    sizeShares <= 0 ||
    !Number.isFinite(avgPrice) ||
    avgPrice <= 0
  ) {
    return null;
  }

  const pnlUsd = firstFiniteNumber([row?.cashPnl, row?.pnl, row?.realizedPnl], (currentPrice - avgPrice) * sizeShares);
  const notionalUsd = sizeShares * Math.max(currentPrice, 0);
  const returnPct = avgPrice > 0 ? (currentPrice - avgPrice) / avgPrice : 0;
  const outcomeIndexRaw = row?.outcomeIndex;
  const outcomeIndex = Number.isFinite(Number(outcomeIndexRaw)) ? Number(outcomeIndexRaw) : null;

  return {
    tokenId,
    market,
    marketSlug: row?.slug || row?.market_slug || row?.eventSlug || null,
    conditionId: row?.conditionId || row?.condition_id || null,
    sizeShares,
    avgPrice,
    currentPrice,
    notionalUsd,
    pnlUsd,
    returnPct,
    outcomeIndex,
    redeemable: Boolean(row?.redeemable),
  };
}

function getTrackedEntrySide(position: PositionSnapshot): "BUY" | "SELL" {
  return position.outcomeIndex === 1 ? "SELL" : "BUY";
}

function isMissingAuditColumnError(error: any): boolean {
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    message.includes("execution_status") ||
    message.includes("execution_error") ||
    message.includes("external_order_id") ||
    message.includes("relay_status") ||
    message.includes("attempts") ||
    message.includes("executed_at") ||
    message.includes("updated_at")
  );
}

function stripUnsupportedBetAuditFields(data: Record<string, any>): Record<string, any> {
  const clone = { ...data };
  delete clone.execution_status;
  delete clone.execution_error;
  delete clone.external_order_id;
  delete clone.relay_status;
  delete clone.attempts;
  delete clone.executed_at;
  delete clone.updated_at;
  return clone;
}

async function insertBetsSafe(sb: any, rows: Record<string, any>[]) {
  const payload = rows.map((row) => ({ ...row }));
  const { error } = await sb.from("bets").insert(payload);
  if (!error) return null;
  if (!isMissingAuditColumnError(error)) return error;
  const { error: retryError } = await sb.from("bets").insert(payload.map(stripUnsupportedBetAuditFields));
  return retryError || null;
}

async function updateBetsSafe(sb: any, ids: string[], patch: Record<string, any>) {
  const { error } = await sb
    .from("bets")
    .update({ ...patch })
    .in("id", ids);
  if (!error) return null;
  if (!isMissingAuditColumnError(error)) return error;
  const { error: retryError } = await sb
    .from("bets")
    .update(stripUnsupportedBetAuditFields({ ...patch }))
    .in("id", ids);
  return retryError || null;
}

async function invokeEdgeFunction(
  supabaseUrl: string,
  supabaseKey: string,
  path: string,
  payload: any,
  timeoutMs = TRADE_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
}

function parseTradeResult(
  market: string,
  tokenId: string,
  side: string,
  fallbackShares: number,
  fallbackPrice: number,
  statusCode: number,
  result: any,
  reason?: string,
): TradeExecResult | null {
  const orderID =
    result?.orderId || result?.orderID || result?.result?.orderID || result?.result?.orderId || result?.orderID || null;
  const rawStatus = (result?.result?.status || result?.status || result?.result?.result?.status || "")
    .toString()
    .toLowerCase();
  const submitted = !!(result?.submitted || result?.success || result?.result?.success || orderID);
  if (!submitted) return null;

  const quantity = firstFiniteNumber(
    [result?.quantity, result?.result?.quantity, result?.result?.result?.quantity, result?.result?.size, result?.size],
    fallbackShares,
  );
  const finalPrice = firstFiniteNumber(
    [result?.finalPrice, result?.result?.finalPrice, result?.price, result?.result?.price],
    fallbackPrice,
  );
  const filledStates = new Set(["matched", "filled", "mined", "confirmed"]);
  const status: TradeExecResult["status"] = filledStates.has(rawStatus) ? "filled" : "pending";

  return {
    market,
    tokenId,
    side,
    size: Number(quantity.toFixed(4)),
    status,
    price: Number(finalPrice.toFixed(4)),
    orderID: orderID || undefined,
    relayStatus: statusCode,
    notionalUsd: Number((quantity * finalPrice).toFixed(4)),
    reason,
  };
}

async function fetchBookMetaForToken(tokenId: string): Promise<any> {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const book = await res.json();
    return {
      bestBid: firstFiniteNumber([book?.bids?.[0]?.price, book?.bestBid, book?.market?.best_bid], NaN),
      bestAsk: firstFiniteNumber([book?.asks?.[0]?.price, book?.bestAsk, book?.market?.best_ask], NaN),
      minimumTickSize: firstFiniteNumber([book?.tick_size, book?.market?.minimum_tick_size], 0.01),
    };
  } catch {
    return null;
  }
}

async function loadExposureContext(sb: any): Promise<ExposureContext> {
  const context: ExposureContext = { marketRiskUsd: {}, tokenRiskUsd: {}, recentMarketTs: {} };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb.from("bets").select("*").eq("is_live", true).gte("created_at", since).limit(800);

  for (const row of data || []) {
    const executionStatus = (row.execution_status || "").toString().toLowerCase();
    const status = (row.status || "").toString().toLowerCase();
    const isOpen = executionStatus
      ? ["pending", "filled"].includes(executionStatus) && ["pending", "filled"].includes(status)
      : status === "pending";
    if (!isOpen) continue;

    const market = (row.market || "").toString();
    const tokenId = (row.token_id || "").toString();
    const sizeShares = Math.max(0, toNumber(row.size, 0));
    const price = Math.max(0.01, toNumber(row.recommended_price, 0.5));
    const riskUsd = sizeShares * price;
    const ts = new Date(row.created_at || 0).getTime();

    if (market) {
      context.marketRiskUsd[market] = (context.marketRiskUsd[market] || 0) + riskUsd;
      if (!context.recentMarketTs[market] || ts > context.recentMarketTs[market]) {
        context.recentMarketTs[market] = ts;
      }
    }
    if (tokenId) {
      context.tokenRiskUsd[tokenId] = (context.tokenRiskUsd[tokenId] || 0) + riskUsd;
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
    if (!isAllowedMarket(market)) continue;
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

    const rawEdge = toNumber(raw?.edge ?? raw?.confidence, 0);
    const edge = Math.min(rawEdge, MAX_TRUSTED_EDGE);
    if (liveTrading && edge < MIN_EDGE_TO_TRADE) continue;

    const metaPrice = getOutcomePriceForSide(meta, action as "BUY" | "SELL");
    const modelPrice = toNumber(raw?.price, NaN);
    const referencePrice = Number.isFinite(modelPrice) ? modelPrice : metaPrice;
    if (!Number.isFinite(referencePrice)) continue;
    if (referencePrice < MIN_ODDS_TO_TRADE || referencePrice > MAX_ODDS_TO_TRADE) continue;
    if (
      liveTrading &&
      action === "BUY" &&
      isShortUpDownMarket(market, minsToEnd) &&
      (edge < SHORT_UPDOWN_BUY_MIN_EDGE || referencePrice > SHORT_UPDOWN_BUY_MAX_PRICE)
    ) {
      continue;
    }

    const spread = getMarketSpread(meta);
    if (liveTrading && spread !== null && spread > MAX_SPREAD_TO_TRADE) continue;
    const executionCost = estimateExecutionCost(meta);
    const netEdge = edge - executionCost;
    if (liveTrading && netEdge < MIN_NET_EDGE_TO_TRADE) continue;

    const computedKelly = computeKellyFraction(netEdge, referencePrice);
    const modelKelly = toNumber(raw?.kelly_f, NaN);
    const baseKelly =
      Number.isFinite(modelKelly) && modelKelly > 0 ? Math.min(modelKelly, computedKelly) : computedKelly;
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
    const marketCapUsd = liveTrading
      ? Math.min(MAX_PER_MARKET_LIVE_RISK_USD, bankroll * MAX_MARKET_EXPOSURE_PCT)
      : maxSize;
    const tokenCapUsd = liveTrading
      ? Math.min(MAX_PER_TOKEN_LIVE_RISK_USD, bankroll * MAX_TOKEN_EXPOSURE_PCT)
      : maxSize;
    const marketCapRemaining = liveTrading ? Math.max(0, marketCapUsd - marketRisk) : maxSize;
    const tokenCapRemaining = liveTrading ? Math.max(0, tokenCapUsd - tokenRisk) : maxSize;
    const riskCap = liveTrading ? Math.min(maxSize, marketCapRemaining, tokenCapRemaining) : maxSize;
    if (liveTrading && riskCap < minSize) continue;
    const size = clamp(proposedSize, minSize, riskCap);

    const expectedValueUsd = size * netEdge;
    if (liveTrading && expectedValueUsd < MIN_EXPECTED_VALUE_USD) continue;

    const urgencyScore = minsToEnd === null ? 0 : minsToEnd <= 15 ? 4 : minsToEnd <= 60 ? 2 : 1;
    const liquidityScore = Math.min(4, Math.log10(Math.max(10, liquidity)) - 3);
    const volumeScore = Math.min(4, Math.log10(Math.max(10, volume)) - 3);
    const spreadScore = spread === null ? 0 : Math.max(-4, 3 - spread * 100);
    const momentum = action === "BUY" ? toNumber(meta.oneHourPriceChange, 0) : -toNumber(meta.oneHourPriceChange, 0);
    const momentumScore = Math.max(-2, Math.min(2, momentum * 100));
    const concentrationPenalty = liveTrading ? Math.min(8, (marketRisk + tokenRisk) * 0.1) : 0;
    const score =
      netEdge * 100 +
      urgencyScore +
      liquidityScore +
      volumeScore +
      spreadScore +
      momentumScore +
      Math.min(10, expectedValueUsd) +
      fractionalKelly * 30 -
      concentrationPenalty;

    dedupe.add(key);
    normalized.push({
      ...raw,
      market,
      action,
      clobTokenIds: tokenIds,
      tokenId,
      edge: Number(netEdge.toFixed(4)),
      price: Number(referencePrice.toFixed(3)),
      size: Number(size.toFixed(2)),
      kelly_f: Number(fractionalKelly.toFixed(4)),
      _score: score,
      _minsToEnd: minsToEnd,
      _volume: volume,
      _liquidity: liquidity,
      _expectedValue: expectedValueUsd,
      _spread: spread,
      _executionCost: executionCost,
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

  // Opening a NO position means buying the NO token, not selling inventory.
  const action = (hypo.action || "BUY").toUpperCase();
  const isNoPosition = action === "SELL" || action === "BUY_NO";
  const tokenId = isNoPosition ? tokenIds[1] || tokenIds[0] : tokenIds[0];
  const tradeSide = "BUY";
  const outcomePriceSide = isNoPosition ? "SELL" : "BUY";

  // Prefer model/fallback price first for speed; fetch midpoint only if invalid.
  let referencePrice = Number(hypo.price || NaN);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || referencePrice >= 1) {
    referencePrice = getOutcomePriceForSide(meta, outcomePriceSide as "BUY" | "SELL") ?? NaN;
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
    return {
      market: hypo.market,
      tokenId,
      side: tradeSide,
      status: "skipped",
      price: 0.5,
      error: "invalid_reference_price",
    };
  }

  const makerPrice = getMakerLimitPrice(meta, "BUY", referencePrice);
  const price = Math.max(0.01, Math.min(0.99, Number(makerPrice.toFixed(3))));

  const requestedRiskUsd = Number(hypo.size || 0);
  const finalRiskUsd = Math.max(
    MIN_LIVE_TRADE_SIZE_USD,
    Number.isFinite(requestedRiskUsd) ? requestedRiskUsd : MIN_LIVE_TRADE_SIZE_USD,
  );
  const fallbackShares = Math.max(0.0001, finalRiskUsd / Math.max(price, 0.01));
  console.log(
    `🔄 Executing: ${action}->${tradeSide} risk $${finalRiskUsd.toFixed(2)} on ${hypo.market} @ $${price.toFixed(3)} (ref $${referencePrice.toFixed(3)})`,
  );

  try {
    // Primary path: place-trade (proven working execution route)
    const primary = await invokeEdgeFunction(supabaseUrl, supabaseKey, "polymarket-trade", {
      action: "place-trade",
      tokenId,
      side: tradeSide,
      size: finalRiskUsd,
      sizeMode: "risk_usd",
      price,
      orderType: "GTC",
      postOnly: true,
    });
    const primaryParsed = parseTradeResult(
      hypo.market,
      tokenId,
      tradeSide,
      fallbackShares,
      price,
      primary.status,
      primary.json,
    );
    if (primary.ok && primaryParsed) {
      console.log(
        `✅ Place-trade ${primaryParsed.status}: ${tradeSide} risk $${finalRiskUsd.toFixed(2)} @ $${primaryParsed.price}`,
      );
      return primaryParsed;
    }

    // Fallback path: execute-trade relay wrapper
    for (let attempt = 1; attempt <= 2; attempt++) {
      const fallback = await invokeEdgeFunction(supabaseUrl, supabaseKey, "execute-trade", {
        tokenId,
        side: tradeSide,
        size: finalRiskUsd,
        sizeMode: "risk_usd",
        price,
        orderType: "GTC",
        postOnly: true,
      });
      const fallbackParsed = parseTradeResult(
        hypo.market,
        tokenId,
        tradeSide,
        fallbackShares,
        price,
        fallback.status,
        fallback.json,
      );
      if (fallback.ok && fallbackParsed) {
        console.log(
          `✅ Execute-trade ${fallbackParsed.status}: ${tradeSide} risk $${finalRiskUsd.toFixed(2)} @ $${fallbackParsed.price}`,
        );
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
        size: Number(fallbackShares.toFixed(4)),
        status: "failed",
        price,
        error: fallback.json?.error || `submission_failed_${fallback.status}`,
        relayStatus: fallback.status,
        notionalUsd: finalRiskUsd,
      };
    }

    return {
      market: hypo.market,
      tokenId,
      side: tradeSide,
      size: Number(fallbackShares.toFixed(4)),
      status: "failed",
      price,
      error: "retry_exhausted",
      notionalUsd: finalRiskUsd,
    };
  } catch (e) {
    return {
      market: hypo.market,
      tokenId,
      side: tradeSide,
      size: Number(fallbackShares.toFixed(4)),
      status: "failed",
      price,
      error: e instanceof Error ? e.message : String(e),
      notionalUsd: finalRiskUsd,
    };
  }
}

async function manageOpenPositions(
  sb: any,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<{ checked: number; triggered: number; closed: number; results: TradeExecResult[]; log?: string }> {
  if (!ENABLE_AUTO_EXITS) {
    return { checked: 0, triggered: 0, closed: 0, results: [], log: "auto_exits_disabled" };
  }

  const [positionsResp, pendingResp] = await Promise.all([
    invokeEdgeFunction(supabaseUrl, supabaseKey, "polymarket-trade", { action: "get-positions" }),
    sb.from("bets").select("*").eq("is_live", true).eq("status", "pending").limit(300),
  ]);

  if (!positionsResp.ok || !Array.isArray(positionsResp.json)) {
    return {
      checked: 0,
      triggered: 0,
      closed: 0,
      results: [],
      log: positionsResp.json?.error || "positions_fetch_failed",
    };
  }

  const pendingBets: any[] = Array.isArray(pendingResp.data) ? pendingResp.data.slice() : [];
  const positions = positionsResp.json.map(normalizePosition).filter(Boolean) as PositionSnapshot[];
  const exitCandidates = positions
    .filter((position) => {
      if (position.redeemable) return false;
      if (!Number.isFinite(position.currentPrice) || position.currentPrice <= 0) return false;
      if (position.sizeShares < MIN_EXIT_POSITION_SHARES) return false;
      if (position.notionalUsd < MIN_EXIT_NOTIONAL_USD) return false;
      return position.returnPct <= -STOP_LOSS_RETURN_PCT || position.returnPct >= TAKE_PROFIT_RETURN_PCT;
    })
    .sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct))
    .slice(0, MAX_EXIT_ORDERS_PER_CYCLE);

  const results: TradeExecResult[] = [];
  let closed = 0;

  for (const position of exitCandidates) {
    const reason = position.returnPct <= -STOP_LOSS_RETURN_PCT ? "stop_loss" : "take_profit";
    const orderType = reason === "stop_loss" ? STOP_LOSS_ORDER_TYPE : TAKE_PROFIT_ORDER_TYPE;
    const postOnly = orderType === "GTC" || orderType === "GTD";
    const bookMeta = await fetchBookMetaForToken(position.tokenId);
    const referencePrice = position.currentPrice;
    const price = postOnly
      ? getMakerLimitPrice(bookMeta || {}, "SELL", referencePrice)
      : getAggressiveExitPrice(bookMeta || {}, referencePrice);

    const response = await invokeEdgeFunction(supabaseUrl, supabaseKey, "polymarket-trade", {
      action: "place-trade",
      tokenId: position.tokenId,
      side: "SELL",
      size: Number(position.sizeShares.toFixed(4)),
      sizeMode: "shares",
      price: Number(price.toFixed(4)),
      orderType,
      postOnly,
    });
    const parsed = parseTradeResult(
      position.market,
      position.tokenId,
      "SELL",
      position.sizeShares,
      Number(price.toFixed(4)),
      response.status,
      response.json,
      reason,
    );

    if (!response.ok || !parsed) {
      results.push({
        market: position.market,
        tokenId: position.tokenId,
        side: "SELL",
        size: Number(position.sizeShares.toFixed(4)),
        status: "failed",
        price: Number(price.toFixed(4)),
        error: response.json?.error || `exit_failed_${response.status}`,
        relayStatus: response.status,
        notionalUsd: Number((position.sizeShares * price).toFixed(4)),
        reason,
      });
      continue;
    }

    results.push(parsed);
    if (parsed.status !== "filled") continue;

    const trackedSide = getTrackedEntrySide(position);
    const matches = pendingBets.filter((bet) => {
      if ((bet.side || "").toString().toUpperCase() !== trackedSide) return false;
      if (position.conditionId && bet.condition_id && bet.condition_id === position.conditionId) return true;
      if (position.marketSlug && bet.market_slug && bet.market_slug === position.marketSlug) return true;
      return (bet.market || "").toLowerCase() === position.market.toLowerCase();
    });

    if (matches.length === 0) continue;

    const ids = matches.map((bet) => bet.id);
    const nowIso = new Date().toISOString();
    for (const bet of matches) {
      const entryPrice = Math.max(0.01, toNumber(bet.recommended_price, position.avgPrice));
      const shares = Math.max(0, toNumber(bet.size, position.sizeShares));
      const pnl = (parsed.price - entryPrice) * shares;
      const patch = {
        status: pnl >= 0 ? "won" : "lost",
        resolution: reason === "stop_loss" ? "STOP_LOSS_EXIT" : "TAKE_PROFIT_EXIT",
        resolved_at: nowIso,
        pnl: Number(pnl.toFixed(6)),
        token_id: bet.token_id || position.tokenId,
        execution_status: "filled",
        external_order_id: parsed.orderID || bet.external_order_id || null,
        updated_at: nowIso,
      };
      const updateError = await updateBetsSafe(sb, [bet.id], patch);
      if (updateError) {
        console.error(`Failed to close tracked bet ${bet.id}:`, updateError);
      }
    }

    closed += ids.length;
    for (const id of ids) {
      const idx = pendingBets.findIndex((bet) => bet.id === id);
      if (idx >= 0) pendingBets.splice(idx, 1);
    }
  }

  return { checked: positions.length, triggered: exitCandidates.length, closed, results };
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
    const systemPrompt =
      body.systemPrompt || "Find high-quality positive-EV trades ending soon while controlling downside risk.";
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

    let exitSummary = { checked: 0, triggered: 0, closed: 0, results: [] as TradeExecResult[], log: "" };
    if (liveTrading) {
      exitSummary = await manageOpenPositions(sb, supabaseUrl, supabaseKey);
      if (exitSummary.triggered > 0) {
        console.log(
          `🚪 Exit manager checked ${exitSummary.checked} positions, triggered ${exitSummary.triggered}, closed ${exitSummary.closed}`,
        );
      }
    }

    if (liveTrading) {
      const guard = await guardRiskLimits(sb, bankroll);
      if (guard.blocked) {
        return new Response(
          JSON.stringify({
            cycle,
            bankroll,
            hypos: [],
            tradeResults: exitSummary.results,
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
Eligible markets must resolve within ${MAX_MARKET_MINUTES} minutes.
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
1. EDGE DETECTION: Use ONLY the provided market data and optional crypto price snapshot when relevant.
   - Do NOT invent news, whale flows, or hidden information.
   - Edge = estimated fair probability - market price. Trade only when edge is clearly positive.
   - Estimate NET edge after spread and fees. If net edge is weak, return no trade.
   - Positive short-term momentum can support BUY/YES; negative momentum can support SELL/NO.
   - Markets ending in <10 min can be considered only if mispricing is obvious and liquidity is real.

2. KELLY SIZING: f* = (p*b - q) / b where p=win_prob, q=1-p, b=odds.
   - Use FRACTIONAL Kelly: bet 1-6% of bankroll per trade.
   - Live mode: respect provided size caps and never force oversized bets.

3. MARKET SELECTION:
   - Consider ALL provided markets. Do not assume you have external informational edge.
   - ONLY markets ending SOON: <10 min is ideal, <= ${MAX_MARKET_MINUTES} min is acceptable. Do NOT trade markets ending later.
   - ONLY high-quality books (volume > $${MIN_VOLUME_TO_TRADE.toFixed(0)} or liquidity > $${MIN_LIQUIDITY_TO_TRADE.toFixed(0)}).
   - Prefer tight books. Avoid wide spreads and avoid low-liquidity traps.
   - Parse "outcomePrices" as "[YesPrice, NoPrice]". Trade the side priced 0.15-0.75.
   - If you cannot justify an edge from the supplied data alone, return 0 hypos.
   - Output 0-2 hypos. It is acceptable to return 0 when no clear edge exists.

4. EXECUTION: Assume passive maker-style entry. Do not rely on crossing the book for mediocre edges.

5. RISK FIRST: Prefer fewer, high-conviction setups. Avoid overtrading.

6. OUTPUT each hypo with: "market" (exact question), "action" (BUY/SELL where SELL means buy NO), "size" (dollar risk amount), "pnl" (0), "price" (entry price), "edge" (estimated net edge), "kelly_f" (kelly fraction used).

CRITICAL:
- ONLY use the exact provided market names.
- ONLY trade markets ending SOON (<= ${MAX_MARKET_MINUTES} min).
- If the provided data does not support a clear positive-EV setup, return 0 hypos.
Output format: {"cycle":N,"bankroll":N,"hypos":[...],"log":"..."}`,
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
    if (exitSummary.triggered > 0) {
      parsed.log += ` | Exits: ${exitSummary.closed} closed of ${exitSummary.triggered} triggered`;
    }

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

    const signalHypos = USE_SIGNAL_HYPOS ? buildSignalHypos(marketsMap, bankroll, liveTrading) : [];
    if (signalHypos.length > 0) {
      parsed.hypos = [...parsed.hypos, ...signalHypos];
      parsed.log += ` | Added ${signalHypos.length} signal candidates`;
    }

    const exposure = liveTrading
      ? await loadExposureContext(sb)
      : { marketRiskUsd: {}, tokenRiskUsd: {}, recentMarketTs: {} };
    const rankedHypos = normalizeAndRankHypos(parsed.hypos, marketsMap, bankroll, liveTrading, exposure);
    const filteredCount = aiCount - rankedHypos.length;
    parsed.hypos = rankedHypos.map(
      ({ _score, _minsToEnd, _volume, _liquidity, _expectedValue, _spread, _executionCost, ...rest }: any) => rest,
    );
    if (filteredCount > 0) {
      parsed.log += ` | Filtered ${filteredCount} low-quality ideas`;
    }
    console.log(`✅ Using ${parsed.hypos.length} validated trade ideas`);

    // Execute trades and save results
    const tradeResults: any[] = [...exitSummary.results];

    if (liveTrading && parsed.hypos.length > 0) {
      console.log(`⚡ Executing ${parsed.hypos.length} live trades...`);

      const hyposToExecute = parsed.hypos.slice(0, MAX_TRADES_PER_CYCLE);
      const entryTradeResults = await executeTradesFast(supabaseUrl, supabaseKey, hyposToExecute, marketsMap);
      tradeResults.push(...entryTradeResults);

      for (let i = 0; i < hyposToExecute.length; i++) {
        const hypo = hyposToExecute[i];
        const tradeResult = entryTradeResults[i] || {
          status: "failed",
          price: hypo.price || 0.5,
          error: "missing_result",
        };

        // Save bet to database with execution status
        const marketMeta = marketsMap[hypo.market] || {};
        const resolutionStatus =
          tradeResult.status === "failed" || tradeResult.status === "skipped" ? "expired" : "pending";
        const betData = {
          cycle: parsed.cycle,
          market: hypo.market || "Unknown",
          market_slug: hypo.market_slug || marketMeta.slug || null,
          condition_id: hypo.condition_id || marketMeta.conditionId || null,
          token_id: tradeResult.tokenId || null,
          side: hypo.action || "BUY",
          recommended_price: tradeResult.price || hypo.price || 0.5,
          size:
            tradeResult.size ||
            Math.max(0.0001, (hypo.size || 0) / Math.max(tradeResult.price || hypo.price || 0.5, 0.01)),
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

        const insertErr = await insertBetsSafe(sb, [betData]);
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
          size: Math.max(0.0001, (h.size || 0) / Math.max(h.price || 0.5, 0.01)),
          confidence: h.edge || null,
          is_live: false,
          status: "pending",
          execution_status: "simulated",
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      });
      if (betsToInsert.length > 0) {
        const insertErr = await insertBetsSafe(sb, betsToInsert);
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
