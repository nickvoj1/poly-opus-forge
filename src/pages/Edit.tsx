import { useState } from "react";
import { Save, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useBotStore } from "@/store/botStore";
import { toast } from "sonner";

const DEFAULT_PROMPT = `JSON output ONLY. Simulate Polymarket exhaustively.

VARS: RSI/ADX/BB/momo/sentiment/spread/corr/gas/oracle_noise/fees.

1. Draft 100 hypos/top markets.
2. 3000 MC paths (hist vol/regimes).
3. Kelly size/score PnL/Sharpe/MDD.
4. Exec top → new bankroll.
5. Rules evolve.

JSON: {"cycle":N,"bankroll":X,"sharpe":Y,"mdd":Z,"hypos":[{"market":"...","action":"BUY/SELL","size":N,"pnl":N}],"rules":[".."],"log":".."}`;

const Edit = () => {
  const { systemPrompt, setSystemPrompt } = useBotStore();
  const [draft, setDraft] = useState(systemPrompt);

  const save = () => {
    setSystemPrompt(draft);
    toast.success("Prompt saved");
  };

  const regenerate = () => {
    setDraft(DEFAULT_PROMPT);
    setSystemPrompt(DEFAULT_PROMPT);
    toast.success("Prompt reset to default");
  };

  return (
    <div className="container py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold font-mono text-primary glow-text">PROMPT EDITOR</h1>
          <p className="text-muted-foreground text-xs font-mono">Edit the Claude system prompt for cycle execution</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={regenerate} variant="outline" className="gap-2 font-mono text-xs">
            <RefreshCw size={14} />
            Reset
          </Button>
          <Button onClick={save} className="gap-2 font-mono text-xs glow-box">
            <Save size={14} />
            Save
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 glow-border">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[calc(100vh-250px)] font-mono text-sm bg-background border-border resize-none"
          placeholder="Enter system prompt…"
        />
      </div>
    </div>
  );
};

export default Edit;
