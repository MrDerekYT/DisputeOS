'use client';

import { Printer } from 'lucide-react';

/** Opens the browser's print dialog. Never printed itself. */
export function PrintButton({ children = 'Print' }: { children?: React.ReactNode }) {
  return <button type="button" className="btn-secondary btn-sm no-print" onClick={() => window.print()}><Printer size={15} aria-hidden /> {children}</button>;
}
