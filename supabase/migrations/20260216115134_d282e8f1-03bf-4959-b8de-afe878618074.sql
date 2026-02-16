
-- Table to track every AI-recommended bet and its real outcome
CREATE TABLE public.bets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cycle INTEGER NOT NULL,
  market TEXT NOT NULL,
  market_slug TEXT,
  condition_id TEXT,
  token_id TEXT,
  side TEXT NOT NULL, -- 'YES' or 'NO' (or 'BUY'/'SELL')
  recommended_price NUMERIC NOT NULL, -- price AI recommended at
  size NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC,
  is_live BOOLEAN NOT NULL DEFAULT false, -- was this a real trade or simulated
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'won', 'lost', 'void', 'expired'
  resolution TEXT, -- 'YES', 'NO', or null if unresolved
  resolved_at TIMESTAMP WITH TIME ZONE,
  pnl NUMERIC, -- calculated real P&L after resolution
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for querying unresolved bets
CREATE INDEX idx_bets_status ON public.bets (status);
CREATE INDEX idx_bets_created_at ON public.bets (created_at DESC);

-- RLS: public access since there's no auth
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bets" ON public.bets
  FOR ALL USING (true) WITH CHECK (true);
