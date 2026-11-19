import { describe, expect, it } from 'vitest';
import { BRAND_SURFACES, brandCss, contrast, HEX, parseHex } from '@/lib/brand';

describe('white-label colours', () => {
  it('accepts only 6-digit hex colours', () => {
    expect(parseHex('#0f766e')).toEqual([15, 118, 110]);
    for (const bad of ['0f766e', '#fff', '#12345g', 'red', "#000000;}body{display:none", '']) expect(parseHex(bad), bad).toBeNull();
    expect(brandCss('javascript:alert(1)')).toBeNull();
    expect(HEX.test('#abcdef')).toBe(true);
  });
  it('produces readable text colours for any chosen colour, in dark (the default) and light', () => {
    for (const hex of ['#ffffff', '#000000', '#ffeb3b', '#0f766e', '#7c3aed', '#e11d48', '#f59e0b', '#9ca3af', '#1e3a8a', '#0f1433', '#96a7ff']) {
      const css = brandCss(hex)!;
      const pick = (src: string, v: string) => new RegExp(`--${v}:(\\d+) (\\d+) (\\d+)`).exec(src)!.slice(1, 4).map(Number) as [number, number, number];
      const dark = /^\.brand-scope\{([^}]*)\}/.exec(css)![1]!;
      const light = /data-theme='light'\] \.brand-scope\{([^}]*)\}/.exec(css)![1]!;
      const night = /\.brand-scope \.night\{([^}]*)\}/.exec(css)![1]!;
      expect(night, 'night panels use the dark set').toBe(dark);
      expect(contrast(pick(light, 'brand-ink'), pick(light, 'brand')), `${hex} ink on brand`).toBeGreaterThanOrEqual(4.5);
      for (const [name, bg] of Object.entries(BRAND_SURFACES.light)) expect(contrast(pick(light, 'brand-strong'), bg), `${hex} brand text on light ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pick(dark, 'brand-ink'), pick(dark, 'brand')), `${hex} dark ink`).toBeGreaterThanOrEqual(4.5);
      for (const [name, bg] of Object.entries(BRAND_SURFACES.dark)) {
        expect(contrast(pick(dark, 'brand'), bg), `${hex} dark brand on ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(pick(dark, 'brand-strong'), bg), `${hex} dark brand text on ${name}`).toBeGreaterThanOrEqual(4.5);
      }
      // brand-coloured text on the brand tint (active pills, the AI-style chips) stays readable in both themes
      expect(contrast(pick(dark, 'brand-strong'), pick(dark, 'brand-soft')), `${hex} dark strong on soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pick(light, 'brand-strong'), pick(light, 'brand-soft')), `${hex} light strong on soft`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
