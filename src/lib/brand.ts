/**
 * White-label portal colours. An agency picks one brand colour; everything derived from it is adjusted so text stays
 * readable (WCAG AA, 4.5:1) in light and dark mode no matter what colour they choose.
 */
export const HEX = /^#[0-9a-f]{6}$/i;
type RGB = [number, number, number];

export const parseHex = (hex: string): RGB | null => (HEX.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB : null);
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as RGB;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [12, 14, 18];
const SURFACE_LIGHT: RGB = [255, 255, 255];
const SURFACE_DARK: RGB = [22, 26, 33];
const trip = (c: RGB) => c.join(' ');

/** Move `c` toward `toward` until it reaches `min` contrast against `bg`. */
function ensure(c: RGB, bg: RGB, toward: RGB, min = 4.5): RGB {
  let out = c;
  for (let i = 0; i < 24 && contrast(out, bg) < min; i++) out = mix(out, toward, 0.08);
  return out;
}

export function brandCss(hex: string | null | undefined): string | null {
  const c = hex ? parseHex(hex) : null;
  if (!c) return null;
  const ink = contrast(WHITE, c) >= contrast(BLACK, c) ? WHITE : BLACK; // text drawn ON the brand colour
  const lightStrong = ensure(c, SURFACE_LIGHT, BLACK); // brand-coloured text on light surfaces
  const darkBrand = ensure(c, SURFACE_DARK, WHITE); // brand colour on dark surfaces
  const darkInk = contrast(WHITE, darkBrand) >= contrast(BLACK, darkBrand) ? WHITE : BLACK;
  const light = `--brand:${trip(c)};--brand-strong:${trip(lightStrong)};--brand-ink:${trip(ink)};--brand-soft:${trip(mix(c, WHITE, 0.88))}`;
  const dark = `--brand:${trip(darkBrand)};--brand-strong:${trip(mix(darkBrand, WHITE, 0.25))};--brand-ink:${trip(darkInk)};--brand-soft:${trip(mix(darkBrand, SURFACE_DARK, 0.8))}`;
  return `.brand-scope{${light}}:root[data-theme='dark'] .brand-scope{${dark}}@media (prefers-color-scheme: dark){:root:not([data-theme='light']) .brand-scope{${dark}}}`;
}
