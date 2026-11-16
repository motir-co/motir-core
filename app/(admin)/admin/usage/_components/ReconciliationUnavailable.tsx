'use client';

import { useRouter } from 'next/navigation';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The Provider bills section's error state (MOTIR-11376; design MOTIR-11375,
 * Panel 7): motir-ai did not answer the reconciliation read. Only the section
 * shows it — the spend sheets above render from their own read. Try again
 * re-renders the page, which reads both again.
 */
export function ReconciliationUnavailable({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const router = useRouter();
  return <ErrorState title={title} description={description} retry={() => router.refresh()} />;
}
