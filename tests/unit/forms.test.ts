import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseForm, UserError, zBool, zDate, zOpt, zText, zUuid } from '@/lib/action';

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };

describe('form parsing (what browsers actually submit)', () => {
  const schema = z.object({ name: zText(20), note: zOpt(50), agree: zBool, extra: zBool, due: zDate.optional().or(z.literal('')), id: zUuid.optional().or(z.literal('')) });

  it('treats an UNCHECKED checkbox (key absent) as false instead of failing', () => {
    expect(parseForm(schema, fd({ name: 'Ann' }))).toMatchObject({ agree: false, extra: false });
  });
  it('treats a checked checkbox as true', () => {
    expect(parseForm(schema, fd({ name: 'Ann', agree: 'on' })).agree).toBe(true);
  });
  it('accepts empty optional fields that browsers send as empty strings', () => {
    const r = parseForm(schema, fd({ name: 'Ann', note: '', due: '', id: '' }));
    expect(r.note).toBeUndefined();
    expect(r.due).toBe('');
  });
  it('reports the first problem in plain words', () => {
    expect(() => parseForm(schema, fd({ name: '' }))).toThrow(UserError);
    expect(() => parseForm(schema, fd({ name: 'Ann', due: '31/12/2026' }))).toThrow(/due: use YYYY-MM-DD/);
  });
  it('ignores Next.js internal action fields and uploaded files', () => {
    const f = fd({ name: 'Ann', $ACTION_ID_abc: 'x' });
    f.append('file', new File(['x'], 'a.txt'));
    expect(parseForm(schema, f).name).toBe('Ann');
  });
  it('collects repeated checkboxes into an array', () => {
    const multi = z.object({ fields: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v])) });
    const f = new FormData(); f.append('fields', 'Balance'); f.append('fields', 'Dates');
    expect(parseForm(multi, f).fields).toEqual(['Balance', 'Dates']);
    expect(parseForm(multi, new FormData()).fields).toEqual([]);
  });
});
