import Link from "next/link";

export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <Link href="/" className="group inline-flex items-center gap-2" aria-label="NOT A BOT home">
      <span
        className={`font-display font-extrabold uppercase leading-none tracking-[0.04em] ${small ? "text-[20px]" : "text-[24px]"}`}
      >
        Not a b<span className="text-amber">o</span>t
      </span>
      <span className="h-2 w-2 bg-amber group-hover:animate-pulse" aria-hidden="true" />
    </Link>
  );
}
