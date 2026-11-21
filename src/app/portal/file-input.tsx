import { fill, tr, type Lang } from '@/lib/portal-i18n';
import { maxUploadBytes, maxUploadMb } from '@/lib/upload';
import { PhotoFileInput } from './photo-file-input';

/**
 * File picker for the portal upload forms: PDF or image, checked against the upload limit before anything is sent. A
 * phone photo too big for the limit is made smaller in the browser first (./photo-file-input.tsx).
 */
export function PortalFileInput({ id, lang }: { id: string; lang: Lang }) {
  const t = tr(lang);
  return <PhotoFileInput id={id} maxBytes={maxUploadBytes()} tooLarge={fill(t('e_fileTooLarge'), { max: maxUploadMb() })} preparing={t('wl_doc_preparing')} />;
}
