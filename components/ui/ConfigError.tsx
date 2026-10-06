import { Wordmark } from "./Wordmark";

/** Shown when the deployment is missing public configuration. */
export function ConfigError({ missing }: { missing: string[] }) {
  return (
    <main className="relative z-10 flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md border border-line bg-ink-2 p-7">
        <Wordmark />
        <p className="label mt-6 text-amber">Room is dark</p>
        <h1 className="font-display mt-2 text-[34px] font-bold uppercase leading-none">Not configured yet</h1>
        <p className="mt-3 text-[14px] text-paper-dim">This deployment is missing environment variables:</p>
        <ul className="mt-2 space-y-1 text-[13px] text-paper">
          {missing.map((m) => (
            <li key={m}>· {m}</li>
          ))}
        </ul>
        <p className="mt-4 text-[13px] text-paper-dim">Copy .env.example to .env.local, fill it in, and restart. See the README.</p>
      </div>
    </main>
  );
}
