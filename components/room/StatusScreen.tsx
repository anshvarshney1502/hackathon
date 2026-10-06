import Link from "next/link";
import { Wordmark } from "@/components/ui/Wordmark";

/** Full-page state card: loading, invalid room, room full, errors. Never a blank screen. */
export function StatusScreen({
  kicker,
  title,
  body,
  action,
  onRetry,
  busy = false,
  children,
}: {
  kicker: string;
  title: string;
  body?: string;
  action?: { href: string; label: string };
  onRetry?: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <main className="relative z-10 flex min-h-dvh flex-col">
      <header className="px-5 py-4 md:px-10">
        <Wordmark />
      </header>
      <div className="flex flex-1 items-center justify-center p-5">
        <div className="w-full max-w-md border border-line bg-ink/85 p-7 backdrop-blur-[2px]" role="status" aria-live="polite">
          <p className="label flex items-center gap-2 text-amber">
            {busy && (
              <span className="inline-flex gap-1" aria-hidden="true">
                <span className="flicker-dot" />
                <span className="flicker-dot" />
                <span className="flicker-dot" />
              </span>
            )}
            {kicker}
          </p>
          <h1 className="font-display mt-2 text-[36px] font-bold uppercase leading-none">{title}</h1>
          {body && <p className="mt-3 text-[14px] text-paper-dim">{body}</p>}
          {children}
          <div className="mt-6 flex gap-3">
            {onRetry && (
              <button
                onClick={onRetry}
                className="font-display cursor-pointer bg-amber px-5 py-2.5 text-[17px] font-bold uppercase tracking-[0.08em] text-ink"
              >
                Try again
              </button>
            )}
            {action && (
              <Link
                href={action.href}
                className="font-display border border-line-strong px-5 py-2.5 text-[17px] font-semibold uppercase tracking-[0.08em] hover:border-paper"
              >
                {action.label}
              </Link>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
