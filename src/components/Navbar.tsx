import { NavLink as RouterNavLink } from "react-router-dom";
import { Activity, Terminal, Settings } from "lucide-react";

const links = [
  { to: "/", label: "Dashboard", icon: Activity },
  { to: "/logs", label: "Logs", icon: Terminal },
  { to: "/edit", label: "Edit", icon: Settings },
];

export function Navbar() {
  return (
    <nav className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="container flex items-center justify-between h-14">
        <div className="flex items-center gap-2">
          <span className="text-primary font-bold text-lg glow-text font-mono">◆ POLYCLAW</span>
          <span className="text-muted-foreground text-xs font-mono">v2</span>
        </div>
        <div className="flex items-center gap-1">
          {links.map((l) => (
            <RouterNavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-mono transition-all ${
                  isActive
                    ? "bg-accent text-accent-foreground glow-border"
                    : "text-muted-foreground hover:text-foreground"
                }`
              }
            >
              <l.icon size={14} />
              {l.label}
            </RouterNavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
