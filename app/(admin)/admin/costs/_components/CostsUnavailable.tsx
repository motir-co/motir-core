'use client';

import { useRouter } from 'next/navigation';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * A Costs source's error state (MOTIR-11712; design MOTIR-11711, Panels 4–6):
 * one source, or both, did not answer. Try again re-renders the page, which reads
 * both sources again.
 */
export function CostsUnavailable({
  title,
  description,
  retryLabel,
  testId,
}: {
  title: string;
  description: string;
  retryLabel: string;
  testId: string;
}) {
  const router = useRouter();
  return (
    <ErrorState
      data-testid={testId}
      title={title}
      description={description}
      retry={() => router.refresh()}
      retryLabel={retryLabel}
    />
  );
}
