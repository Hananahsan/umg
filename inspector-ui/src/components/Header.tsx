import { formatBytes, type Overview } from "../api";
import { useCountUp } from "./useCountUp";

export function Header({ data }: { data: Overview }): React.JSX.Element {
  const total = useCountUp(data.total_active);

  return (
    <header className="panel-field border-b border-line px-6 pt-9 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <span className="rule">umg0 inspect</span>
            <Badge tone="accent">read-only</Badge>
            {data.source === "demo" && <Badge tone="warn">demo dataset</Badge>}
          </div>

          <div className="mt-5 flex items-end gap-4">
            <span className="text-6xl leading-none font-semibold tabular-nums">
              {total}
            </span>
            <span className="mb-1.5 text-xs text-muted">
              active memories
              <br />
              <span className="text-faint">
                {data.archived} archived · cap {data.global_cap}
              </span>
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-2.5 text-xs sm:grid-cols-3">
          <Stat label="avg decay" value={data.avg_decay.toFixed(3)} />
          <Stat label="avg importance" value={data.avg_importance.toFixed(3)} />
          <Stat label="namespace" value={data.namespace} />
          <Stat label="score floor" value={data.eviction_floor.toFixed(2)} />
          <Stat label="merge at" value={data.merge_threshold.toFixed(2)} />
          <Stat
            label="db size"
            value={data.source === "demo" ? "—" : formatBytes(data.db_size_bytes)}
            warn={data.db_size_warn}
          />
        </dl>
      </div>

      <p
        className="mt-5 truncate font-mono text-[11px] text-faint"
        title={data.db_path}
      >
        {data.db_path}
      </p>
    </header>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="rule">{label}</dt>
      <dd
        className="mt-0.5 tabular-nums"
        style={warn ? { color: "var(--color-op-evict)" } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "accent" | "warn";
  children: React.ReactNode;
}): React.JSX.Element {
  const color = tone === "accent" ? "var(--color-accent)" : "var(--color-working)";
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[10px] tracking-[0.14em] uppercase"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}
