import { useCallback, useRef } from "react";
import { Play, Square, RotateCcw, DollarSign, TrendingUp, BarChart3, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/StatCard";
import { PnLChart } from "@/components/PnLChart";
import { HyposChart } from "@/components/HyposChart";
import { useBotStore } from "@/store/botStore";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const Dashboard = () => {
  const { running, cycle, bankroll, sharpe, mdd, pnlHistory, hypos, setRunning, addCycleResult, addLog, reset, systemPrompt } = useBotStore();
  const abortRef = useRef<AbortController | null>(null);

  const runCycle = useCallback(async () => {
    const state = useBotStore.getState();
    addLog(`Starting cycle ${state.cycle + 1}...`);

    try {
      const { data, error } = await supabase.functions.invoke("run-cycle", {
        body: {
          cycle: state.cycle + 1,
          bankroll: state.bankroll,
          systemPrompt: state.systemPrompt,
        },
      });

      if (error) throw error;

      if (data?.error) {
        addLog(`ERROR: ${data.error}`);
        toast.error(data.error);
        return false;
      }

      addCycleResult(data);
      addLog(`Cycle ${data.cycle} complete. Bankroll: $${data.bankroll.toFixed(2)}`);
      return true;
    } catch (e: any) {
      addLog(`ERROR: ${e.message}`);
      toast.error("Cycle failed: " + e.message);
      return false;
    }
  }, [addCycleResult, addLog, systemPrompt]);

  const startBot = useCallback(async () => {
    setRunning(true);
    abortRef.current = new AbortController();
    addLog("Bot started.");

    while (useBotStore.getState().running) {
      const ok = await runCycle();
      if (!ok || !useBotStore.getState().running) break;
      // Small delay between cycles
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
        <div className="flex items-center gap-2">
          {!running ? (
            <Button onClick={startBot} className="gap-2 font-mono glow-box">
              <Play size={16} />
              START
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
        <div className={`w-2 h-2 rounded-full ${running ? "bg-primary animate-pulse-glow" : "bg-muted-foreground"}`} />
        <span className="text-xs font-mono text-muted-foreground">
          {running ? "RUNNING" : "IDLE"} • Cycle {cycle}
        </span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Bankroll" value={bankroll} prefix="$" icon={<DollarSign size={16} />} variant={bankroll >= 100 ? "positive" : "negative"} />
        <StatCard label="Sharpe" value={sharpe} icon={<TrendingUp size={16} />} variant={sharpe > 0 ? "positive" : "default"} />
        <StatCard label="Cycles" value={cycle} icon={<BarChart3 size={16} />} />
        <StatCard label="Max DD" value={mdd} suffix="%" icon={<AlertTriangle size={16} />} variant={mdd > 10 ? "negative" : "default"} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PnLChart data={pnlHistory} />
        <HyposChart hypos={hypos} />
      </div>
    </div>
  );
};

export default Dashboard;
