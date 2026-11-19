import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/ui';

/** A record that does not exist in this workspace (or belongs to another one). Shown inside the app, so the way back is the app. */
export default function AppNotFound() {
  return (
    <EmptyState icon={<FileQuestion size={20} />} title="Nothing at this address"
      body="This record does not exist in your workspace, or it has been deleted. Check the link, or go back and open it from its list."
      action={<Link href="/app" className="btn-primary">Back to the dashboard</Link>} />
  );
}
