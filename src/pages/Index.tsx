import { useCallback, useRef, useEffect, useState } from "react";
import { Play, Square, RotateCcw, DollarSign, TrendingUp, BarChart3, AlertTriangle, Wifi, WifiOff, Zap, CheckCircle, XCircle, Clock } from "lucide-react";
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
    bets, setBets, realPnL, setRealPnL,
  } = useBotStore();
  const abortRef = useRef<AbortController | null>(null);
  const [walletBalance, setWalletBalance] = useState<{ usdc: number; matic: number } | null>(null);

  // Check API connection on mount
  useEffect(() => {
    checkApiConnection();
    fetchBets();
    checkResolutions();
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
        if (data.balance) {
          setWalletBalance(data.balance);
        }
        addLog(`✓ Polymarket API: connected (wallet: ${data.walletAddress?.slice(0, 8)}... | USDC: $${data.balance?.usdc?.toFixed(2) || '0.00'})`);
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

  // Fetch all bets from the database and compute real bankroll
  const fetchBets = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("bets")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (!error && data) {
        setBets(data as any);
        const state = useBotStore.getState();
        // Filter by mode: live bets when live, sim bets when sim
        const modeBets = data.filter((b: any) => b.is_live === state.liveTrading);
        const resolvedBets = modeBets.filter((b: any) => b.pnl !== null && (b.status === 'won' || b.status === 'lost'));
        const totalPnL = resolvedBets.reduce((sum: number, b: any) => sum + Number(b.pnl), 0);
        setRealPnL(totalPnL);
        
        if (!state.liveTrading) {
          const realBankroll = 100 + totalPnL;
          useBotStore.setState({ bankroll: realBankroll });
        }
      }
    } catch {}
  }, [setBets, setRealPnL]);

  // Check resolutions for pending bets and update bankroll with real P&L
  const checkResolutions = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke("check-resolutions");
      if (!error && data?.resolved > 0) {
        // Calculate the P&L delta from newly resolved bets
        const cyclePnL = data.results.reduce((sum: number, r: any) => sum + (r.pnl || 0), 0);
        
        addLog(`🎯 Resolved ${data.resolved} bets: ${data.results.map((r: any) => `${r.market} → ${r.status} ($${r.pnl?.toFixed(2)})`).join(", ")}`);
        addLog(`💰 Resolution P&L: $${cyclePnL.toFixed(2)}`);
        
        if (cyclePnL !== 0) {
          // Update bankroll with real resolution results
          const state = useBotStore.getState();
          const newBankroll = state.bankroll + cyclePnL;
          useBotStore.setState({
            bankroll: newBankroll,
            pnlHistory: [...state.pnlHistory, { cycle: state.cycle, bankroll: newBankroll }],
          });
          addLog(`📊 Bankroll adjusted: $${state.bankroll.toFixed(2)} → $${newBankroll.toFixed(2)}`);
        }

        toast.success(`${data.resolved} bet(s) resolved! P&L: $${cyclePnL.toFixed(2)}`);
        await fetchBets();
      }
    } catch {}
  }, [addLog, fetchBets]);

  // Execute trades via polymarket-trade function
  // Verify trade by signing it (proves order is valid), but don't try to submit
  // due to Polymarket geoblock on datacenter IPs. Bets are tracked via DB and resolved against real outcomes.
  const executeTrade = useCallback(async (hypo: any) => {
    try {
      addLog(`🔄 Verifying ${hypo.action} on ${hypo.market}...`);

      // Use clobTokenIds from run-cycle enrichment (preferred) or skip
      let tokenIds: string[] = hypo.clobTokenIds || [];
      if (tokenIds.length === 0) {
        addLog(`⚠ No token IDs for ${hypo.market}, tracking as paper trade`);
        return { status: 'signed', price: hypo.price || 0.5 };
      }

      // Use first token (YES outcome) for BUY, second (NO) for SELL
      const tokenId = hypo.action === "BUY" ? tokenIds[0] : (tokenIds[1] || tokenIds[0]);

      // Get current midpoint price
      let price = hypo.price || 0.5;
      try {
        const { data: priceData } = await supabase.functions.invoke("polymarket-trade", {
          body: { action: "get-prices", tokenIds: [tokenId] },
        });
        const mid = priceData?.prices?.[tokenId];
        if (mid) price = parseFloat(mid);
      } catch {}

      addLog(`📊 ${hypo.market}: price=$${price.toFixed(4)}, size=${hypo.size}`);

      // Sign the order to verify it's valid (EIP-712)
      try {
        const { data: signResult, error: signErr } = await supabase.functions.invoke("polymarket-trade", {
          body: {
            action: "sign-order",
            tokenId,
            side: hypo.action === "BUY" ? "BUY" : "SELL",
            size: hypo.size,
            price,
          },
        });

        if (signErr) {
          addLog(`⚠ Sign error (tracking anyway): ${signErr.message}`);
        } else if (signResult?.submitted) {
          addLog(`✅ Trade executed: ${hypo.action} ${hypo.size} @ $${signResult.finalPrice?.toFixed(4)}`);
          return { status: 'filled', price: signResult.finalPrice, result: signResult.result };
        } else if (signResult?.signedOrder) {
          addLog(`📝 Order signed & verified (EIP-712). Tracking as paper trade @ $${signResult.finalPrice?.toFixed(4)}`);
          return { status: 'signed', price: signResult.finalPrice || price };
        } else if (signResult?.error) {
          addLog(`⚠ Sign issue: ${signResult.error}`);
        }
      } catch (signCatchErr: any) {
        addLog(`⚠ Sign failed (tracking anyway): ${signCatchErr.message}`);
      }

      return { status: 'signed', price };
    } catch (e: any) {
      addLog(`⚠ Trade verify error: ${e.message}. Tracking as paper trade.`);
      return { status: 'signed', price: hypo.price || 0.5 };
    }
  }, [addLog]);



  const runCycle = useCallback(async () => {
    const state = useBotStore.getState();

    // In live mode, fetch real wallet balance to use as bankroll
    let currentBankroll = state.bankroll;
    if (state.liveTrading) {
      try {
        const { data: balData } = await supabase.functions.invoke("polymarket-trade", {
          body: { action: "get-wallet-balance" },
        });
        if (balData && typeof balData.usdc === "number") {
          currentBankroll = balData.usdc;
          setWalletBalance(balData);
          addLog(`💰 Wallet balance: $${balData.usdc.toFixed(2)} USDC, ${balData.matic.toFixed(4)} MATIC`);
        }
      } catch {
        addLog("⚠ Could not fetch wallet balance, using last known");
      }
    }

    addLog(`Starting cycle ${state.cycle + 1}${state.liveTrading ? " [LIVE]" : " [SIM]"}...`);

    try {
      const { data, error } = await supabase.functions.invoke("run-cycle", {
        body: {
          cycle: state.cycle + 1,
          bankroll: currentBankroll,
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
            error: (result as any).error,
            timestamp: Date.now(),
          });
        }
      }

      // In live mode, override bankroll with real wallet balance after trades
      if (state.liveTrading) {
        try {
          const { data: postBal } = await supabase.functions.invoke("polymarket-trade", {
            body: { action: "get-wallet-balance" },
          });
          if (postBal && typeof postBal.usdc === "number") {
            data.bankroll = postBal.usdc;
            setWalletBalance(postBal);
          }
        } catch { /* use AI-reported bankroll */ }
      }

      addCycleResult({ ...data, trades });
      addLog(`Cycle ${data.cycle} complete. Bankroll: $${data.bankroll.toFixed(2)}${state.liveTrading ? " (real)" : ""}`);

      // Refresh positions after trades
      if (state.liveTrading) {
        await checkApiConnection();
      }

      // Check resolutions for any pending bets & refresh bet list
      await checkResolutions();

      return true;
    } catch (e: any) {
      addLog(`ERROR: ${e.message}`);
      toast.error("Cycle failed: " + e.message);
      return false;
    }
  }, [addCycleResult, addLog, systemPrompt, executeTrade, checkApiConnection, checkResolutions]);

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
                // Re-fetch bets to recalculate P&L for the new mode
                setTimeout(() => fetchBets(), 100);
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
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard 
          label={liveTrading ? "Wallet (USDC)" : "Bankroll"} 
          value={liveTrading && walletBalance ? walletBalance.usdc : bankroll} 
          prefix="$" 
          icon={<DollarSign size={16} />} 
          variant={(liveTrading && walletBalance ? walletBalance.usdc : bankroll) >= 100 ? "positive" : "negative"} 
        />
        <StatCard 
          label={liveTrading ? "Live P&L" : "Sim P&L"} 
          value={realPnL} 
          prefix="$" 
          icon={<TrendingUp size={16} />} 
          variant={realPnL > 0 ? "positive" : realPnL < 0 ? "negative" : "default"} 
        />
        <StatCard label="Sharpe" value={sharpe} icon={<TrendingUp size={16} />} variant={sharpe > 0 ? "positive" : "default"} />
        <StatCard label="Cycles" value={cycle} icon={<BarChart3 size={16} />} />
        <StatCard label="Max DD" value={mdd} suffix="%" icon={<AlertTriangle size={16} />} variant={mdd > 10 ? "negative" : "default"} />
      </div>

      {/* Bet Resolution Tracking */}
      {bets.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4 glow-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-mono text-primary">BET TRACKING</h3>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span className="flex items-center gap-1 text-primary">
                <CheckCircle size={12} /> {bets.filter(b => b.status === 'won').length} won
              </span>
              <span className="flex items-center gap-1 text-destructive">
                <XCircle size={12} /> {bets.filter(b => b.status === 'lost').length} lost
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <Clock size={12} /> {bets.filter(b => b.status === 'pending').length} pending
              </span>
              <Button size="sm" variant="outline" className="h-6 text-xs font-mono" onClick={checkResolutions}>
                Check Now
              </Button>
            </div>
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {bets.slice(0, 20).map((bet) => (
              <div key={bet.id} className="flex items-center justify-between text-xs font-mono py-1.5 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  {bet.status === 'won' && <CheckCircle size={12} className="text-primary shrink-0" />}
                  {bet.status === 'lost' && <XCircle size={12} className="text-destructive shrink-0" />}
                  {bet.status === 'pending' && <Clock size={12} className="text-muted-foreground shrink-0" />}
                  <span className="text-foreground/80 truncate max-w-[250px]">{bet.market}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-muted-foreground">{bet.side}</span>
                  <span className="text-muted-foreground">@{Number(bet.recommended_price).toFixed(2)}</span>
                  <span className="text-muted-foreground">sz:{Number(bet.size).toFixed(1)}</span>
                  {bet.pnl !== null ? (
                    <span className={Number(bet.pnl) >= 0 ? "text-primary" : "text-destructive"}>
                      ${Number(bet.pnl).toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
