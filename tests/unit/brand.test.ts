import { describe, expect, it } from 'vitest';
import { brandCss, contrast, HEX, parseHex } from '@/lib/brand';

describe('white-label colours', () => {
  it('accepts only 6-digit hex colours', () => {
    expect(parseHex('#0f766e')).toEqual([15, 118, 110]);
    for (const bad of ['0f766e', '#fff', '#12345g', 'red', "#000000;}body{display:none", '']) expect(parseHex(bad), bad).toBeNull();
    expect(brandCss('javascript:alert(1)')).toBeNull();
    expect(HEX.test('#abcdef')).toBe(true);
  });
  it('produces readable text colours for any chosen colour, in light and dark', () => {
    for (const hex of ['#ffffff', '#000000', '#ffeb3b', '#0f766e', '#7c3aed', '#e11d48', '#f59e0b', '#9ca3af', '#1e3a8a']) {
      const css = brandCss(hex)!;
      const get = (scope: string, v: string) => new RegExp(`${scope}[^}]*--${v}:(\\d+) (\\d+) (\\d+)`).exec(css)!.slice(1, 4).map(Number) as [number, number, number];
      const light = css.split(':root')[0]!;
      const pick = (src: string, v: string) => new RegExp(`--${v}:(\\d+) (\\d+) (\\d+)`).exec(src)!.slice(1, 4).map(Number) as [number, number, number];
      expect(contrast(pick(light, 'brand-ink'), pick(light, 'brand')), `${hex} ink on brand`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pick(light, 'brand-strong'), [255, 255, 255]), `${hex} brand text on white`).toBeGreaterThanOrEqual(4.5);
      const dark = /data-theme='dark'\] \.brand-scope\{([^}]*)\}/.exec(css)![1]!;
      expect(contrast(pick(dark, 'brand-ink'), pick(dark, 'brand')), `${hex} dark ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pick(dark, 'brand'), [22, 26, 33]), `${hex} dark brand on surface`).toBeGreaterThanOrEqual(4.5);
      void get;
    }
  });
});
