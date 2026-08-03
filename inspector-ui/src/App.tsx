import { useCallback, useEffect, useState } from "react";
import { fetchOverview, type Overview, type Source } from "./api";
import { Header } from "./components/Header";
import { TierRail } from "./components/TierRail";

export function App(): React.JSX.Element {
  const [source, setSource] = useState<Source | undefined>(undefined);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((next?: Source) => {
    setError(null);
    fetchOverview(next)
      .then((d) => {
        setData(d);
        setSource(d.source);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="grain min-h-screen">
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className="overflow-hidden rounded-lg border border-line bg-ink-raised shadow-[0_24px_80px_-40px_rgba(0,0,0,0.9)]">
          {error && <ErrorPanel message={error} onRetry={() => load(source)} />}
          {!error && !data && <LoadingPanel />}
          {!error && data && (
            <>
              <Header data={data} />
              {data.thin && <ThinBanner onDemo={() => load("demo")} />}
              {data.source === "demo" && (
                <DemoNotice onDatabase={() => load("database")} />
              )}
              <section>
                {data.tiers.map((tier, i) => (
                  <TierRail key={tier.tier} tier={tier} index={i} />
                ))}
              </section>
            </>
          )}
        </div>

        <p className="mt-4 px-1 text-[11px] text-faint">
          The inspector never writes to your memories. The database is opened
          read-only.
        </p>
      </main>
    </div>
  );
}

function ThinBanner({ onDemo }: { onDemo: () => void }): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4"
      style={{ background: "color-mix(in srgb, var(--color-working) 7%, transparent)" }}
    >
      <p className="text-xs text-muted">
        <span style={{ color: "var(--color-working)" }}>Not much here yet.</span>{" "}
        Consolidation is hard to see on a nearly empty database.
      </p>
      <button
        type="button"
        onClick={onDemo}
        className="rounded border border-line-strong px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
      >
        Load demo dataset →
      </button>
    </div>
  );
}

function DemoNotice({
  onDatabase,
}: {
  onDatabase: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3">
      <p className="text-[11px] text-faint">
        Synthetic data, held in memory. Your database is untouched.
      </p>
      <button
        type="button"
        onClick={onDatabase}
        className="text-[11px] text-muted underline underline-offset-4 transition-colors hover:text-text"
      >
        show my database
      </button>
    </div>
  );
}

function LoadingPanel(): React.JSX.Element {
  return (
    <div className="px-6 py-20 text-center text-xs text-faint">reading…</div>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm" style={{ color: "var(--color-op-evict)" }}>
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded border border-line-strong px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
      >
        retry
      </button>
    </div>
  );
}
