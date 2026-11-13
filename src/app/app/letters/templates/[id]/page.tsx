import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActionForm, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { Notice, PageHeader } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { KIND_LABEL, MERGE_FIELDS, templateByKey, type LetterKind } from '@/lib/letters/templates';
import { isUuid } from '@/lib/util';
import { saveTemplateAction } from '../../actions';

export const metadata: Metadata = { title: 'Template' };

/** `/templates/new?base=<system key>` starts from a standard template; `/templates/<uuid>` edits your own. */
export default async function TemplateEditor({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ base?: string }> }) {
  const { id } = await params;
  const { base } = await searchParams;
  const ctx = await requireStaff('letters:approve');
  let t: { id?: string; name: string; kind: LetterKind; language: 'en' | 'es'; body: string; baseKey?: string } | null = null;
  if (id === 'new') {
    const b = base ? templateByKey(base) : undefined;
    t = b ? { name: `${b.name.split(' — ')[0]} (our version)`, kind: b.kind, language: b.language, body: b.body, baseKey: b.key } : { name: '', kind: 'bureau_dispute', language: 'en', body: '' };
  } else if (isUuid(id)) {
    const r = await ctx.tx((db) => db.row<{ id: string; name: string; kind: LetterKind; language: 'en' | 'es'; body: string; base_key: string | null }>('select id, name, kind, language, body, base_key from public.letter_templates where id = $1', [id]));
    if (r) t = { id: r.id, name: r.name, kind: r.kind, language: r.language, body: r.body, baseKey: r.base_key ?? undefined };
  }
  if (!t) notFound();
  return (
    <>
      <PageHeader title={t.id ? 'Edit template' : 'New template'} back={{ href: '/app/letters?tab=templates', label: 'Templates' }} />
      <div className="mx-auto max-w-3xl space-y-4">
        <Notice tone="info" title="Merge fields">
          Write <code>{'{{field}}'}</code> where details should appear: {MERGE_FIELDS.map((f) => <code key={f} className="mr-1.5 rounded bg-raised px-1">{`{{${f}}}`}</code>)}. Templates are checked for prohibited claims (guarantees, promised removals, score promises) and cannot be saved with them.
        </Notice>
        <ActionForm action={saveTemplateAction} className="card card-pad space-y-5">
          {t.id && <input type="hidden" name="id" value={t.id} />}{t.baseKey && <input type="hidden" name="baseKey" value={t.baseKey} />}
          <Field label="Name" name="name" defaultValue={t.name} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Type" name="kind" defaultValue={t.kind} options={Object.entries(KIND_LABEL).map(([k, v]) => ({ value: k, label: v }))} />
            <Select label="Language" name="language" defaultValue={t.language} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
          </div>
          <TextArea label="Body" name="body" rows={22} defaultValue={t.body} required />
          <div className="flex justify-end"><SubmitButton>Save template</SubmitButton></div>
        </ActionForm>
      </div>
    </>
  );
}
