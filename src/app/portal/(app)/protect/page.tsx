import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { ActionForm, Field, SubmitButton } from '@/components/forms';
import { PortalTitle } from '@/components/portal-kit';
import { Badge, Notice } from '@/components/ui';
import { PROTECTION_GROUPS, PROTECTION_KIND_LABEL, protectionTicks, type ProtectionOption } from '@/lib/credit/protections';
import { businessToday } from '@/lib/letters/service';
import { portalContext } from '@/lib/portal';
import { fill, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { fmtDate } from '@/lib/util';
import { portalProtectionAction } from '../../protect-actions';

export const metadata: Metadata = { title: 'Protect your file' };

/**
 * "Protect your file": security freezes, fraud alerts, opt-outs and similar steps the client takes personally with
 * each agency, on the agency's own page. We only link to the official page and keep the client's own note of the day
 * they did it. We never submit one for the client and never ask for an agency login, PIN or password.
 */
export default async function PortalProtect() {
  const { ctx, t, lang } = await portalContext();
  const row = await ctx.tx((db) => db.row<{ file_protections: unknown }>('select file_protections from public.clients where id = $1', [ctx.clientId]));
  const ticks = protectionTicks(row?.file_protections);
  const today = businessToday();
  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/portal" className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden /> {t('home')}</Link>
      <PortalTitle sub={t('pf_sub')}>{t('pf_title')}</PortalTitle>
      <Notice tone="info" title={t('pf_mineTitle')}>{t('pf_mine')}</Notice>
      <p className="text-sm text-muted">{t('pf_notDispute')} <Link className="link" href="/portal/disputes">{t('disputes')}</Link></p>
      <ul className="space-y-3">
        {PROTECTION_GROUPS.map((g) => {
          const done = g.options.filter((o) => ticks[o.key]).length;
          return (
            <li key={g.org} className="card p-4 sm:p-5">
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">
                    <span className="font-semibold">{g.name}</span>
                    <span className="block text-[0.8125rem] text-muted">{g.options.map((o) => PROTECTION_KIND_LABEL[o.kind][lang]).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}</span>
                  </span>
                  <Badge tone={done ? 'ok' : 'neutral'}>{fill(t('pf_count'), { done, total: g.options.length })}</Badge>
                </summary>
                <p className="mt-3 text-sm text-muted">{g.note[lang]}</p>
                <ul className="mt-4 divide-y divide-line">
                  {g.options.map((o) => <Option key={o.key} o={o} name={g.name} on={ticks[o.key] ?? null} today={today} lang={lang} t={t} />)}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">{t('pf_sources')}</p>
    </div>
  );
}

function Option({ o, name, on, today, lang, t }: { o: ProtectionOption; name: string; on: string | null; today: string; lang: Lang; t: (k: PortalKey) => string }) {
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[0.9375rem] font-semibold">{PROTECTION_KIND_LABEL[o.kind][lang]}</h3>
        {o.free && <Badge tone="info">{t('pf_free')}</Badge>}
        {on && <Badge tone="ok" dot>{fill(t('pf_done'), { date: fmtDate(on, lang) })}</Badge>}
      </div>
      <dl className="space-y-1.5 text-sm">
        <div><dt className="inline font-medium">{t('pf_does')} </dt><dd className="inline text-muted">{o.does[lang]}</dd></div>
        <div><dt className="inline font-medium">{t('pf_doesNot')} </dt><dd className="inline text-muted">{o.doesNot[lang]}</dd></div>
        {o.who && <div><dt className="inline font-medium">{t('pf_who')} </dt><dd className="inline text-muted">{o.who[lang]}</dd></div>}
      </dl>
      <p className="text-sm">
        {o.link
          ? <a className="link inline-flex items-center gap-1.5" href={o.link.url} target="_blank" rel="noopener noreferrer">{fill(t('pf_open'), { name })} <ExternalLink size={14} aria-hidden /></a>
          : <span className="text-muted">{fill(t('pf_noLink'), { name })}</span>}
        {o.phone && <span className="text-muted"> · {fill(t('pf_call'), { phone: o.phone.number })}</span>}
      </p>
      <ActionForm action={portalProtectionAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="option" value={o.key} />
        <Field label={t('pf_placed')} name="on" type="date" defaultValue={on ?? today} max={today} required className="w-44" />
        <SubmitButton variant="secondary">{t('pf_save')}</SubmitButton>
        {on && <button type="submit" name="clear" value="1" formNoValidate className="btn-quiet">{t('pf_clear')}</button>}
      </ActionForm>
    </li>
  );
}
