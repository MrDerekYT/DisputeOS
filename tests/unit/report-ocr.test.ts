import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { OcrError, ocrReport, SCAN_FIELD_CONFIDENCE, SCAN_WARNING, stripFullNumbers } from '@/lib/reports/ocr';
import { AI_READ_WARNING, LAYOUT_NOT_KNOWN, markAiRead, NO_SCAN_CREDITS, readReportFile, ReportReadError, reportMimes, SCANS_OFF_IMAGE } from '@/lib/reports/read-file';
import { lowConfidenceFields, parseReportText } from '@/lib/reports/parser';
import { REVIEW_THRESHOLD } from '@/lib/reports/types';

/** A one-page PDF with no text layer: what a scanner produces, minus the picture. */
function blankPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const TRANSCRIPT = `Equifax Credit Report
Report Date: 03/02/2026

Accounts
Creditor: CAPITAL ONE
Account Number: XXXX4821
Account Status: Open
Payment Status: 30 days late
Balance: $1,240.00
Date Opened: 05/14/2021

Collections
Creditor: MIDLAND CREDIT MGMT
Original Creditor: SYNCHRONY BANK
Account Number: XXXX0937
Balance: $612.00

Inquiries
CARMAX AUTO FINANCE - 01/10/2026`;

const payer = { orgId: '00000000-0000-0000-0000-000000000001', userId: '00000000-0000-0000-0000-000000000002' };
const credits = (ok = true) => ({
  spend: vi.fn(async () => (ok ? { ok: true as const, cost: 10, id: 7 } : { ok: false as const, reason: 'insufficient' as const })),
  settle: vi.fn(async () => undefined),
  refund: vi.fn(async () => undefined),
});

afterEach(() => { delete process.env.OCR_PROVIDER; delete process.env.ANTHROPIC_API_KEY; delete process.env.OCR_MODEL; resetEnvCache(); });

describe('reading scanned reports', () => {
  it('is off by default: a scanned PDF is refused with the old message and images are not accepted', async () => {
    expect(reportMimes()).not.toContain('image/png');
    const c = credits();
    await expect(readReportFile({ bytes: blankPdf(), mime: 'application/pdf', name: 'scan.pdf' }, payer, { credits: c })).rejects.toThrow(/no readable text/);
    await expect(readReportFile({ bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', name: 'p.jpg' }, payer, { credits: c })).rejects.toThrow(SCANS_OFF_IMAGE);
    expect(c.spend).not.toHaveBeenCalled();
  });

  it('reads a scanned PDF through OCR, charges once and flags every field for review', async () => {
    const c = credits();
    const ocr = vi.fn(async () => TRANSCRIPT);
    const r = await readReportFile({ bytes: blankPdf(), mime: 'application/pdf', name: 'scan.pdf' }, payer, { enabled: () => true, ocr, credits: c });
    expect(r.via).toBe('ai_scan');
    expect(ocr).toHaveBeenCalledWith({ bytes: expect.any(Buffer), mime: 'application/pdf' });
    expect(r.parsed.bureau).toBe('equifax');
    expect(r.parsed.tradelines).toHaveLength(2);
    expect(r.parsed.tradelines[1]!.item_type).toBe('collection');
    expect(r.parsed.inquiries[0]!.name).toBe('CARMAX AUTO FINANCE');
    expect(r.parsed.warnings[0]).toBe(SCAN_WARNING);
    for (const t of r.parsed.tradelines) {
      expect(t.confidence).toBeLessThan(REVIEW_THRESHOLD);
      expect(lowConfidenceFields(t).length).toBe(Object.keys(t.field_meta).length);
    }
    expect(c.spend).toHaveBeenCalledWith(payer.orgId, 'report_scan', payer.userId);
    expect(c.settle).toHaveBeenCalledWith(7);
    expect(c.refund).not.toHaveBeenCalled();
  });

  it('reads a photo when turned on', async () => {
    const r = await readReportFile({ bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', name: 'p.jpg' }, payer, { enabled: () => true, ocr: async () => TRANSCRIPT, credits: credits() });
    expect(r.parsed.tradelines).toHaveLength(2);
  });

  it('refunds when the reader fails or finds nothing, and refuses with no credits', async () => {
    const c1 = credits();
    await expect(readReportFile({ bytes: blankPdf(), mime: 'application/pdf', name: 's.pdf' }, payer, { enabled: () => true, ocr: async () => { throw new OcrError('down'); }, credits: c1 })).rejects.toThrow(ReportReadError);
    expect(c1.refund).toHaveBeenCalledTimes(1);
    expect(c1.settle).not.toHaveBeenCalled();

    const c2 = credits();
    await expect(readReportFile({ bytes: blankPdf(), mime: 'application/pdf', name: 's.pdf' }, payer, { enabled: () => true, ocr: async () => 'Experian Credit Report\n\nnothing here', credits: c2 })).rejects.toThrow(/No credits were used/);
    expect(c2.refund).toHaveBeenCalledTimes(1);

    const c3 = credits(false);
    const ocr = vi.fn(async () => TRANSCRIPT);
    await expect(readReportFile({ bytes: blankPdf(), mime: 'application/pdf', name: 's.pdf' }, payer, { enabled: () => true, ocr, credits: c3 })).rejects.toThrow(NO_SCAN_CREDITS);
    expect(ocr).not.toHaveBeenCalled();
  });

  it('text files never touch OCR or credits', async () => {
    const c = credits();
    const ocr = vi.fn();
    const r = await readReportFile({ bytes: Buffer.from(TRANSCRIPT), mime: 'text/plain', name: 'r.txt' }, payer, { enabled: () => true, ocr, credits: c });
    expect(r.via).toBe('rules');
    expect(ocr).not.toHaveBeenCalled();
    expect(c.spend).not.toHaveBeenCalled();
  });

  it('markScanned keeps confidences at or below the scan level', () => {
    const p = markAiRead(parseReportText(TRANSCRIPT));
    for (const t of p.tradelines) for (const m of Object.values(t.field_meta)) expect(m.confidence).toBeLessThanOrEqual(SCAN_FIELD_CONFIDENCE);
  });
});

describe('ocr output clean-up', () => {
  it('cuts account numbers to the last 4 and removes SSN-shaped numbers', () => {
    const out = stripFullNumbers('Account Number: 4111 1111 1111 4821\nAcct #: ****0937\nAccount Number: XXXX1234\nRemarks: SSN 123-45-6789 on file');
    expect(out).toBe('Account Number: XXXX4821\nAcct #: XXXX0937\nAccount Number: XXXX1234\nRemarks: SSN [removed] on file');
  });
});

describe('ocr provider call', () => {
  it('sends a PDF as a document block and returns the cleaned transcript', async () => {
    process.env.OCR_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'test-key'; resetEnvCache();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('claude-sonnet-5-5');
      expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Account Number: 4111111111114821' }] }), { status: 200 });
    });
    expect(await ocrReport({ bytes: Buffer.from('%PDF'), mime: 'application/pdf' }, fetchImpl as unknown as typeof fetch)).toBe('Account Number: XXXX4821');
  });

  it('sends a photo as an image block, and reports errors plainly', async () => {
    process.env.OCR_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.OCR_MODEL = 'claude-haiku-5-5'; resetEnvCache();
    const ok = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'NOT_A_CREDIT_REPORT' }] }), { status: 200 });
    });
    await expect(ocrReport({ bytes: Buffer.from('x'), mime: 'image/png' }, ok as unknown as typeof fetch)).rejects.toThrow(/does not look like a credit report/);
    const bad = vi.fn(async () => new Response('{}', { status: 529 }));
    await expect(ocrReport({ bytes: Buffer.from('x'), mime: 'image/png' }, bad as unknown as typeof fetch)).rejects.toThrow(/HTTP 529/);
  });

  it('goes through OpenRouter (OpenAI-compatible) with the AI connection: PDF as a file part, photo as an image part', async () => {
    Object.assign(process.env, { OCR_PROVIDER: 'openai', AI_BASE_URL: 'https://openrouter.ai/api/v1/', AI_API_KEY: 'or-key', AI_MODEL: 'some/vision-model' }); resetEnvCache();
    const calls: { url: string; body: any; auth: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization ?? '' });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Acct #: 4111111111110937' } }] }), { status: 200 });
    });
    expect(await ocrReport({ bytes: Buffer.from('%PDF'), mime: 'application/pdf' }, fetchImpl as unknown as typeof fetch)).toBe('Acct #: XXXX0937');
    await ocrReport({ bytes: Buffer.from('x'), mime: 'image/jpeg' }, fetchImpl as unknown as typeof fetch);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer or-key');
    expect(calls[0]!.body.model).toBe('some/vision-model');
    expect(calls[0]!.body.messages[0]).toMatchObject({ role: 'system' });
    expect(calls[0]!.body.messages[1].content[1]).toMatchObject({ type: 'file', file: { filename: 'report.pdf', file_data: expect.stringMatching(/^data:application\/pdf;base64,/) } });
    expect(calls[1]!.body.messages[1].content[1]).toMatchObject({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } });
    for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) delete process.env[k];
  });

  it('refuses when turned off', async () => {
    await expect(ocrReport({ bytes: Buffer.from('x'), mime: 'image/png' })).rejects.toThrow(/not turned on/);
  });
});

/** Text as it comes out of an AnnualCreditReport.com PDF: bureau layout, not "Label: value" blocks. */
const ANNUAL = `annualcreditreport.com
Experian
Prepared for JORDAN A RIVERA
Date generated Mar 2, 2026  Report number 1234-5678-90
Potentially negative items or items for further review
CAPITAL ONE  PO BOX 30281 SALT LAKE CITY UT 84130
Account number 517805XXXXXX  Recent balance $1,240 as of 02/2026  Status Open. $45 past due as of Feb 2026.
Date opened 05/2021  Type Credit card  Credit limit or original amount $1,500`;

describe('AnnualCreditReport.com and other bureau layouts', () => {
  it('sends the report text (not the file) to AI and files what comes back', async () => {
    const c = credits();
    const ocr = vi.fn(async () => TRANSCRIPT);
    const r = await readReportFile({ bytes: Buffer.from(ANNUAL), mime: 'text/plain', name: 'experian.txt' }, payer, { enabled: () => true, ocr, credits: c });
    expect(r.via).toBe('ai_text');
    expect(ocr).toHaveBeenCalledWith({ text: expect.stringContaining('annualcreditreport.com') });
    expect(r.parsed.tradelines.map((t) => t.creditor_name)).toEqual(['CAPITAL ONE', 'MIDLAND CREDIT MGMT']);
    expect(r.parsed.tradelines[0]!.balance_cents).toBe(124000);
    expect(r.parsed.tradelines[0]!.account_last4).toBe('4821');
    expect(r.parsed.warnings[0]).toBe(AI_READ_WARNING);
    expect(c.settle).toHaveBeenCalledTimes(1);
  });

  it('says plainly what to do when the layout is unknown and AI reading is off', async () => {
    await expect(readReportFile({ bytes: Buffer.from('Some bank statement\nNothing here'), mime: 'text/plain', name: 'x.txt' }, payer, { enabled: () => false, credits: credits() })).rejects.toThrow(LAYOUT_NOT_KNOWN);
  });

  it('a report in the plain layout is read by the rules for free, even with AI on', async () => {
    const c = credits();
    const ocr = vi.fn();
    const r = await readReportFile({ bytes: Buffer.from(TRANSCRIPT), mime: 'text/plain', name: 'r.txt' }, payer, { enabled: () => true, ocr, credits: c });
    expect(r.via).toBe('rules');
    expect(ocr).not.toHaveBeenCalled();
  });

  it('sends report text to OpenRouter as plain text', async () => {
    Object.assign(process.env, { OCR_PROVIDER: 'openai', AI_BASE_URL: 'https://openrouter.ai/api/v1', AI_API_KEY: 'k', AI_MODEL: 'm' }); resetEnvCache();
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(typeof body.messages[1].content).toBe('string');
      expect(body.messages[1].content).toContain('<report>');
      return new Response(JSON.stringify({ choices: [{ message: { content: TRANSCRIPT } }] }), { status: 200 });
    });
    expect(await ocrReport({ text: ANNUAL }, fetchImpl as unknown as typeof fetch)).toContain('CAPITAL ONE');
    for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) delete process.env[k];
  });
});
