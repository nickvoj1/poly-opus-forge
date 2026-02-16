import { useState, useRef, useEffect } from "react";
import { Search, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useBotStore } from "@/store/botStore";

const Logs = () => {
  const { logs } = useBotStore();
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = search
    ? logs.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : logs;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="container py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold font-mono text-primary glow-text">TERMINAL</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter logs…"
              className="pl-8 h-8 w-48 font-mono text-xs bg-card"
            />
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => useBotStore.setState({ logs: [] })}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg glow-border scanline overflow-hidden">
        <div className="h-[calc(100vh-200px)] overflow-y-auto p-4 terminal-scroll">
          {filtered.length === 0 ? (
            <div className="text-muted-foreground font-mono text-sm flex items-center gap-2">
              <span className="animate-pulse-glow">▌</span> Waiting for logs…
            </div>
          ) : (
            filtered.map((log, i) => (
              <div key={i} className="text-sm font-mono leading-6 text-foreground/80 hover:text-primary transition-colors">
                <span className="text-primary/50 mr-2">{String(i + 1).padStart(3, "0")}</span>
                {log}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};

export default Logs;
