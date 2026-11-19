import type { ReactNode } from 'react';
import { MarketingFrame } from '@/components/marketing-site';

/** Public pages other than the home page (which uses the same frame directly): shared header and footer. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <MarketingFrame>{children}</MarketingFrame>;
}
