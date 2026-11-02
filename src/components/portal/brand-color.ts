/**
 * Tenant brand colour maths. A brand colour is only ever a validated #rrggbb (see resolveBrand), so the CSS
 * this produces is safe to inline. Fills use the brand as-is; text gets a darker (light mode) or lighter
 * (dark mode) shade that keeps at least 4.5:1 against the surfaces it sits on.
 */
type RGB = [number, number, number];

const toRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: RGB) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(toRgb(a));
  const lb = luminance(toRgb(b));
  const [x, y] = la > lb ? [la, lb] : [lb, la];
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Shift `hex` toward black or white until it reads at `min`:1 on `bg`. */
export function readableOn(
  hex: string,
  bg: string,
  toward: "black" | "white",
  min = 4.5,
): string {
  const base = toRgb(hex);
  const target: RGB = toward === "black" ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1; t += 0.04) {
    const c = toHex(mix(base, target, t));
    if (contrast(c, bg) >= min) return c;
  }
  return toward === "black" ? "#000000" : "#ffffff";
}

/** Text colour for a brand-filled surface (buttons, the logo monogram). */
export function inkFor(hex: string): string {
  return contrast(hex, "#ffffff") >= contrast(hex, "#111113")
    ? "#ffffff"
    : "#111113";
}

/** The :root variables the portal theme reads (see portal.css). */
export function brandVars(hex: string): string {
  const text = readableOn(hex, "#f2f2ef", "black"); // light: surface-2 is the darkest surface text sits on
  const textDark = readableOn(hex, "#1e1e22", "white"); // dark: raised is the lightest
  return `:root{--brand:${hex};--brand-ink:${inkFor(hex)};--brand-text:${text};--brand-text-dark:${textDark}}`;
}
