import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { Hypo } from "@/store/botStore";

interface HyposChartProps {
  hypos: Hypo[];
}

export function HyposChart({ hypos }: HyposChartProps) {
  const data = hypos.slice(0, 10).map((h) => ({
    name: h.market.length > 20 ? h.market.slice(0, 20) + "…" : h.market,
    pnl: h.pnl,
  }));

  return (
    <div className="bg-card border border-border rounded-lg p-4 glow-border">
      <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">Top Hypotheses P&L</h3>
      {data.length === 0 ? (
        <div className="h-[250px] flex items-center justify-center text-muted-foreground font-mono text-sm">
          Awaiting cycle data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(150 30% 12%)" />
            <XAxis type="number" stroke="hsl(0 0% 45%)" fontSize={11} fontFamily="JetBrains Mono" />
            <YAxis type="category" dataKey="name" width={120} stroke="hsl(0 0% 45%)" fontSize={10} fontFamily="JetBrains Mono" />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(0 0% 4%)",
                border: "1px solid hsl(150 30% 12%)",
                borderRadius: "6px",
                fontFamily: "JetBrains Mono",
                fontSize: 12,
                color: "hsl(0 0% 90%)",
              }}
            />
            <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.pnl >= 0 ? "hsl(150, 100%, 50%)" : "hsl(0, 85%, 55%)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
