import { useCallback, useRef, useEffect } from "react";
import { Play, Square, RotateCcw, DollarSign, TrendingUp, BarChart3, AlertTriangle, Wifi, WifiOff, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/StatCard";
import { PnLChart } from "@/components/PnLChart";
import { HyposChart } from "@/components/HyposChart";
import { useBotStore } from "@/store/botStore";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const Dashboard = () => {
  const {
    running, cycle, bankroll, sharpe, mdd, pnlHistory, hypos,
    setRunning, addCycleResult, addLog, reset, systemPrompt,
    liveTrading, setLiveTrading, positions, setPositions, apiConnected, setApiConnected,
  } = useBotStore();
  const abortRef = useRef<AbortController | null>(null);

  // Check API connection on mount
  useEffect(() => {
    checkApiConnection();
  }, []);

  const checkApiConnection = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke("polymarket-trade", {
        body: { action: "verify-connection" },
      });
      if (error || !data?.connected) {
        setApiConnected(false);
        addLog("⚠ Polymarket API: not connected or invalid credentials");
      } else {
        setApiConnected(true);
        addLog(`✓ Polymarket API: connected (wallet: ${data.walletAddress?.slice(0, 8)}...)`);
        // Fetch positions
        const { data: posData } = await supabase.functions.invoke("polymarket-trade", {
          body: { action: "get-positions" },
        });
        if (Array.isArray(posData)) {
          setPositions(posData.map((p: any) => ({
            market: p.title || p.market || p.asset || "Unknown",
            tokenId: p.token_id || p.asset || "",
            size: Number(p.size || 0),
            avgPrice: Number(p.avg_price || 0),
            currentPrice: Number(p.cur_price || p.price || 0),
            pnl: Number(p.pnl || 0),
          })));
        }
      }
    } catch {
      setApiConnected(false);
    }
  }, [setApiConnected, addLog, setPositions]);

  // Execute trades via polymarket-trade function
  const executeTrade = useCallback(async (hypo: any) => {
    try {
      addLog(`🔄 Executing ${hypo.action} on ${hypo.market}...`);

      // For now, we search for the market to get token IDs
      const { data: searchData } = await supabase.functions.invoke("polymarket-trade", {
        body: { action: "search-markets", query: hypo.market },
      });

      const markets = searchData?.markets || [];
      if (markets.length === 0) {
        addLog(`❌ Market not found: ${hypo.market}`);
        return { status: 'failed', error: 'Market not found' };
      }

      const market = markets[0];
      // clobTokenIds is a JSON string array like '["tokenId1","tokenId2"]'
      let tokenIds: string[] = [];
      try {
        tokenIds = JSON.parse(market.clobTokenIds || "[]");
      } catch {
        tokenIds = [];
      }

      if (tokenIds.length === 0) {
        addLog(`❌ No token IDs for: ${hypo.market}`);
        return { status: 'failed', error: 'No token IDs' };
      }

      // Use first token (YES outcome) for BUY, second (NO) for SELL
      const tokenId = hypo.action === "BUY" ? tokenIds[0] : (tokenIds[1] || tokenIds[0]);

      // Get current midpoint price
      const { data: priceData } = await supabase.functions.invoke("polymarket-trade", {
        body: { action: "get-prices", tokenIds: [tokenId] },
      });

      const currentPrice = priceData?.prices?.[tokenId] || "0.50";
      const price = parseFloat(currentPrice);

      addLog(`📊 ${hypo.market}: price=$${price.toFixed(4)}, size=${hypo.size}`);

      // Place the trade
      const { data: tradeResult } = await supabase.functions.invoke("polymarket-trade", {
        body: {
          action: "place-trade",
          tokenId,
          side: hypo.action === "BUY" ? "BUY" : "SELL",
          size: hypo.size,
          price,
        },
      });

      if (tradeResult?.error) {
        addLog(`❌ Trade failed: ${tradeResult.error}`);
        return { status: 'failed', error: tradeResult.error };
      }

      addLog(`✅ Trade executed: ${hypo.action} ${hypo.size} @ $${price.toFixed(4)}`);
      return { status: 'filled', price };
    } catch (e: any) {
      addLog(`❌ Trade error: ${e.message}`);
      return { status: 'failed', error: e.message };
    }
  }, [addLog]);

  const runCycle = useCallback(async () => {
    const state = useBotStore.getState();
    addLog(`Starting cycle ${state.cycle + 1}${state.liveTrading ? " [LIVE]" : " [SIM]"}...`);

    try {
      const { data, error } = await supabase.functions.invoke("run-cycle", {
        body: {
          cycle: state.cycle + 1,
          bankroll: state.bankroll,
          systemPrompt: state.systemPrompt,
          liveTrading: state.liveTrading,
        },
      });

      if (error) throw error;

      if (data?.error) {
        addLog(`ERROR: ${data.error}`);
        toast.error(data.error);
        return false;
      }

      // If live trading is on, execute the trades
      const trades: any[] = [];
      if (state.liveTrading && data.hypos && data.hypos.length > 0) {
        addLog(`⚡ Live mode: executing ${data.hypos.length} trades...`);
        for (const hypo of data.hypos.slice(0, 3)) { // Max 3 trades per cycle
          const result = await executeTrade(hypo);
          trades.push({
            market: hypo.market,
            tokenId: "",
            side: hypo.action,
            size: hypo.size,
            price: result.price || 0,
            status: result.status,
            error: result.error,
            timestamp: Date.now(),
          });
        }
      }

      addCycleResult({ ...data, trades });
      addLog(`Cycle ${data.cycle} complete. Bankroll: $${data.bankroll.toFixed(2)}`);

      // Refresh positions after trades
      if (state.liveTrading && trades.length > 0) {
        await checkApiConnection();
      }

      return true;
    } catch (e: any) {
      addLog(`ERROR: ${e.message}`);
      toast.error("Cycle failed: " + e.message);
      return false;
    }
  }, [addCycleResult, addLog, systemPrompt, executeTrade, checkApiConnection]);

  const startBot = useCallback(async () => {
    const state = useBotStore.getState();
    if (state.liveTrading && !state.apiConnected) {
      toast.error("Polymarket API not connected. Check your credentials.");
      return;
    }
    if (state.liveTrading) {
      toast.warning("⚡ LIVE TRADING MODE — Real money at risk!", { duration: 5000 });
    }

    setRunning(true);
    abortRef.current = new AbortController();
    addLog(state.liveTrading ? "⚡ Bot started in LIVE mode." : "Bot started in simulation mode.");

    while (useBotStore.getState().running) {
      const ok = await runCycle();
      if (!ok || !useBotStore.getState().running) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    setRunning(false);
    addLog("Bot stopped.");
  }, [runCycle, setRunning, addLog]);

  const stopBot = useCallback(() => {
    setRunning(false);
    abortRef.current?.abort();
    addLog("Stopping bot...");
  }, [setRunning, addLog]);

  return (
    <div className="container py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono glow-text text-primary">POLYCLAW v2</h1>
          <p className="text-muted-foreground text-sm font-mono">Live Polymarket Bot Dashboard</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Live Trading Toggle */}
          <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 glow-border">
            <Label htmlFor="live-mode" className="text-xs font-mono text-muted-foreground cursor-pointer">
              {liveTrading ? "LIVE" : "SIM"}
            </Label>
            <Switch
              id="live-mode"
              checked={liveTrading}
              onCheckedChange={(v) => {
                if (running) {
                  toast.error("Stop the bot before switching modes");
                  return;
                }
                setLiveTrading(v);
                addLog(v ? "⚡ Switched to LIVE trading mode" : "📊 Switched to simulation mode");
              }}
              className="data-[state=checked]:bg-destructive"
            />
            {liveTrading && <Zap size={14} className="text-destructive animate-pulse" />}
          </div>

          {/* API Status */}
          <div className="flex items-center gap-1.5">
            {apiConnected ? (
              <Wifi size={14} className="text-primary" />
            ) : (
              <WifiOff size={14} className="text-muted-foreground" />
            )}
            <span className="text-xs font-mono text-muted-foreground">
              {apiConnected ? "API" : "NO API"}
            </span>
          </div>

          {!running ? (
            <Button onClick={startBot} className="gap-2 font-mono glow-box">
              <Play size={16} />
              {liveTrading ? "START LIVE" : "START"}
            </Button>
          ) : (
            <Button onClick={stopBot} variant="destructive" className="gap-2 font-mono">
              <Square size={16} />
              STOP
            </Button>
          )}
          <Button onClick={reset} variant="outline" size="icon" className="font-mono">
            <RotateCcw size={16} />
          </Button>
        </div>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${running ? (liveTrading ? "bg-destructive animate-pulse" : "bg-primary animate-pulse-glow") : "bg-muted-foreground"}`} />
        <span className="text-xs font-mono text-muted-foreground">
          {running ? (liveTrading ? "🔴 LIVE TRADING" : "RUNNING") : "IDLE"} • Cycle {cycle}
        </span>
      </div>

      {/* Live trading warning */}
      {liveTrading && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-center gap-2">
          <Zap size={16} className="text-destructive shrink-0" />
          <span className="text-xs font-mono text-destructive">
            LIVE TRADING ENABLED — Real orders will be placed on Polymarket. Ensure your wallet is funded.
          </span>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Bankroll" value={bankroll} prefix="$" icon={<DollarSign size={16} />} variant={bankroll >= 100 ? "positive" : "negative"} />
        <StatCard label="Sharpe" value={sharpe} icon={<TrendingUp size={16} />} variant={sharpe > 0 ? "positive" : "default"} />
        <StatCard label="Cycles" value={cycle} icon={<BarChart3 size={16} />} />
        <StatCard label="Max DD" value={mdd} suffix="%" icon={<AlertTriangle size={16} />} variant={mdd > 10 ? "negative" : "default"} />
      </div>

      {/* Positions (when live) */}
      {liveTrading && positions.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 glow-border">
          <h3 className="text-sm font-mono text-primary mb-3">OPEN POSITIONS</h3>
          <div className="space-y-2">
            {positions.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-xs font-mono py-1 border-b border-border/50 last:border-0">
                <span className="text-foreground/80 truncate max-w-[200px]">{p.market}</span>
                <div className="flex items-center gap-4">
                  <span className="text-muted-foreground">Size: {p.size}</span>
                  <span className="text-muted-foreground">Avg: ${p.avgPrice.toFixed(4)}</span>
                  <span className={p.pnl && p.pnl >= 0 ? "text-primary" : "text-destructive"}>
                    {p.pnl ? `$${p.pnl.toFixed(2)}` : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PnLChart data={pnlHistory} />
        <HyposChart hypos={hypos} />
      </div>
    </div>
  );
};

export default Dashboard;
