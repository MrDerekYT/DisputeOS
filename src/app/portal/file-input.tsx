import { FileInput } from '@/components/file-input';
import { fill, tr, type Lang } from '@/lib/portal-i18n';
import { maxUploadBytes, maxUploadMb } from '@/lib/upload';

/** File picker for the portal upload forms: PDF or image, checked against the upload limit before anything is sent. */
export function PortalFileInput({ id, lang }: { id: string; lang: Lang }) {
  return <FileInput id={id} accept=".pdf,.png,.jpg,.jpeg" maxBytes={maxUploadBytes()} tooLarge={fill(tr(lang)('e_fileTooLarge'), { max: maxUploadMb() })} />;
}
