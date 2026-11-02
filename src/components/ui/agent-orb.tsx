import { cn } from "@/lib/utils";

/**
 * Every AI employee gets a unique, calm color derived from its seed.
 * Deterministic (same seed → same orb), no network, works in light and dark.
 */
function hash(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function orbColors(seed: string) {
  const h = hash(seed);
  // A curated set of calm hues (no neon, no muddy yellows) so every agent looks intentional.
  const hues = [255, 275, 300, 330, 15, 35, 150, 170, 195, 220];
  const hue = hues[h % hues.length]!;
  const shift = 18 + ((h >> 8) % 14);
  return { a: `oklch(0.72 0.11 ${hue})`, b: `oklch(0.6 0.13 ${(hue + shift) % 360})` };
}

/**
 * Agent avatar: a matte two-tone disc (no gloss) with an optional initial.
 * Pass `name` to show the agent's initial; the seed (agent id) keeps colors stable across renames.
 */
export function AgentOrb({ seed, size = 32, className, live, name }: { seed: string; size?: number; className?: string; live?: boolean; name?: string | null }) {
  const { a, b } = orbColors(seed);
  const initial = name?.trim()?.[0]?.toUpperCase();
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        letterSpacing: "-0.01em",
        background: `linear-gradient(140deg, ${a}, ${b})`,
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.06)",
        textShadow: "0 1px 1px rgb(0 0 0 / 0.12)",
      }}
    >
      {initial && size >= 18 ? initial : null}
      {live ? (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface bg-good" />
      ) : null}
    </span>
  );
}

export function Avatar({ name, size = 28, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const label = (name ?? "?")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-medium text-ink-2 ring-1 ring-line", className)}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
    >
      {label || "?"}
    </span>
  );
}
