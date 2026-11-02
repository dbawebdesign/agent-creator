import { cn } from "@/lib/utils";

/**
 * Every AI employee gets a unique, calm gradient "orb" derived from its seed.
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
  const hue = h % 360;
  const hue2 = (hue + 40 + ((h >> 9) % 80)) % 360;
  return { a: `oklch(0.78 0.13 ${hue})`, b: `oklch(0.58 0.17 ${hue2})` };
}

export function AgentOrb({ seed, size = 32, className, live }: { seed: string; size?: number; className?: string; live?: boolean }) {
  const { a, b } = orbColors(seed);
  const angle = hash(seed + "angle") % 360;
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 28%, rgb(255 255 255 / 0.55), transparent 42%), conic-gradient(from ${angle}deg, ${a}, ${b}, ${a})`,
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.06), 0 1px 2px rgb(0 0 0 / 0.08)",
      }}
    >
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
