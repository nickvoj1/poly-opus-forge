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

interface BetRecord {
  id: string;
  cycle: number;
  market: string;
  side: string;
  recommended_price: number;
  size: number;
  status: 'pending' | 'won' | 'lost' | 'void' | 'expired';
  resolution: string | null;
  pnl: number | null;
  is_live: boolean;
  created_at: string;
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
  bets: BetRecord[];
  realPnL: number;
  setRunning: (v: boolean) => void;
  addCycleResult: (r: CycleResult) => void;
  addLog: (msg: string) => void;
  setSystemPrompt: (p: string) => void;
  setLiveTrading: (v: boolean) => void;
  setPositions: (p: Position[]) => void;
  addTrade: (t: TradeExecution) => void;
  setApiConnected: (v: boolean) => void;
  setBets: (b: BetRecord[]) => void;
  setRealPnL: (p: number) => void;
  reset: () => void;
}

const DEFAULT_PROMPT = `JSON output ONLY. Aggressive Kelly Criterion strategy.

EDGE DETECTION: TRUE_prob - market_price > 20% required.
- BTC 24h change: NEGATIVE → SELL/NO, POSITIVE → BUY/YES.
- Volume spikes + liquidity shifts = secondary signals.
- High-volume markets ONLY (>$10k volume or >$5k liquidity).

KELLY SIZING: f* = (p*b-q)/b → Aggressive 15% bankroll per trade.
- Live: max $2.70/trade. Sim: 15% bankroll.
- Target 5+ trades per cycle, 20+ trades/day.
- Compound winners → 4 sessions/day → 250% daily target.
- Max drawdown: 30%.

JSON: {"cycle":N,"bankroll":X,"sharpe":Y,"mdd":Z,"hypos":[{"market":"exact name","action":"BUY/SELL","size":N,"pnl":0,"price":0.5,"edge":0.25,"kelly_f":0.15}],"rules":[".."],"log":".."}`;

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
  bets: [],
  realPnL: 0,
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
  setBets: (b) => set({ bets: b }),
  setRealPnL: (p) => set({ realPnL: p }),
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
      bets: [],
      realPnL: 0,
    }),
}));
