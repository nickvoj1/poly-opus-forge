import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface PnLChartProps {
  data: { cycle: number; bankroll: number }[];
}

export function PnLChart({ data }: PnLChartProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 glow-border">
      <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">P&L Curve</h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(150 30% 12%)" />
          <XAxis dataKey="cycle" stroke="hsl(0 0% 45%)" fontSize={11} fontFamily="JetBrains Mono" />
          <YAxis stroke="hsl(0 0% 45%)" fontSize={11} fontFamily="JetBrains Mono" domain={["dataMin - 5", "dataMax + 5"]} />
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
          <Line
            type="monotone"
            dataKey="bankroll"
            stroke="hsl(150, 100%, 50%)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "hsl(150, 100%, 50%)" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
