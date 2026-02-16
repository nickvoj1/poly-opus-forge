import { create } from 'zustand';

export interface Hypo {
  market: string;
  action: string;
  size: number;
  pnl: number;
  tokenId?: string;
  price?: number;
}

export interface CycleResult {
  cycle: number;
  bankroll: number;
  sharpe: number;
  mdd: number;
  hypos: Hypo[];
  rules: string[];
  log: string;
  trades?: TradeExecution[];
}

export interface TradeExecution {
  market: string;
  tokenId: string;
  side: string;
  size: number;
  price: number;
  status: 'pending' | 'filled' | 'failed';
  error?: string;
  timestamp: number;
}

export interface Position {
  market: string;
  tokenId: string;
  size: number;
  avgPrice: number;
  currentPrice?: number;
  pnl?: number;
}

interface BotState {
  running: boolean;
  cycle: number;
  bankroll: number;
  sharpe: number;
  mdd: number;
  pnlHistory: { cycle: number; bankroll: number }[];
  hypos: Hypo[];
  logs: string[];
  rules: string[];
  systemPrompt: string;
  liveTrading: boolean;
  positions: Position[];
  tradeHistory: TradeExecution[];
  apiConnected: boolean;
  setRunning: (v: boolean) => void;
  addCycleResult: (r: CycleResult) => void;
  addLog: (msg: string) => void;
  setSystemPrompt: (p: string) => void;
  setLiveTrading: (v: boolean) => void;
  setPositions: (p: Position[]) => void;
  addTrade: (t: TradeExecution) => void;
  setApiConnected: (v: boolean) => void;
  reset: () => void;
}

const DEFAULT_PROMPT = `JSON output ONLY. Analyze Polymarket markets and recommend trades.

VARS: RSI/ADX/BB/momo/sentiment/spread/corr/gas/oracle_noise/fees.

1. Draft 100 hypos/top markets.
2. 3000 MC paths (hist vol/regimes).
3. Kelly size/score PnL/Sharpe/MDD.
4. Exec top → new bankroll.
5. Rules evolve.

JSON: {"cycle":N,"bankroll":X,"sharpe":Y,"mdd":Z,"hypos":[{"market":"...","action":"BUY/SELL","size":N,"pnl":N}],"rules":[".."],"log":".."}`;

export const useBotStore = create<BotState>((set) => ({
  running: false,
  cycle: 0,
  bankroll: 100,
  sharpe: 0,
  mdd: 0,
  pnlHistory: [{ cycle: 0, bankroll: 100 }],
  hypos: [],
  logs: [],
  rules: [],
  systemPrompt: DEFAULT_PROMPT,
  liveTrading: false,
  positions: [],
  tradeHistory: [],
  apiConnected: false,
  setRunning: (v) => set({ running: v }),
  addCycleResult: (r) =>
    set((s) => ({
      cycle: r.cycle,
      bankroll: r.bankroll,
      sharpe: r.sharpe,
      mdd: r.mdd,
      hypos: r.hypos,
      rules: r.rules,
      pnlHistory: [...s.pnlHistory, { cycle: r.cycle, bankroll: r.bankroll }],
      logs: [...s.logs, `[Cycle ${r.cycle}] ${r.log}`],
      tradeHistory: r.trades ? [...s.tradeHistory, ...r.trades] : s.tradeHistory,
    })),
  addLog: (msg) => set((s) => ({ logs: [...s.logs, `[${new Date().toLocaleTimeString()}] ${msg}`] })),
  setSystemPrompt: (p) => set({ systemPrompt: p }),
  setLiveTrading: (v) => set({ liveTrading: v }),
  setPositions: (p) => set({ positions: p }),
  addTrade: (t) => set((s) => ({ tradeHistory: [...s.tradeHistory, t] })),
  setApiConnected: (v) => set({ apiConnected: v }),
  reset: () =>
    set({
      running: false,
      cycle: 0,
      bankroll: 100,
      sharpe: 0,
      mdd: 0,
      pnlHistory: [{ cycle: 0, bankroll: 100 }],
      hypos: [],
      logs: [],
      rules: [],
      tradeHistory: [],
    }),
}));
