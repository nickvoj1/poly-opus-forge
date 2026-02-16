import { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  icon?: ReactNode;
  variant?: "default" | "positive" | "negative";
}

export function StatCard({ label, value, prefix, suffix, icon, variant = "default" }: StatCardProps) {
  const valueColor =
    variant === "positive"
      ? "text-primary"
      : variant === "negative"
      ? "text-destructive"
      : "text-foreground";

  return (
    <div className="bg-card border border-border rounded-lg p-4 glow-border hover:glow-box transition-shadow">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
        {icon && <span className="text-primary/60">{icon}</span>}
      </div>
      <div className={`text-2xl font-bold font-mono ${valueColor}`}>
        {prefix}
        {typeof value === "number" ? value.toFixed(2) : value}
        {suffix}
      </div>
    </div>
  );
}
