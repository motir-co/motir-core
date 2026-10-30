'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/auth/client';

// "Sign in with a different account" on the Refused page (design
// `design/preview/preview-gate.mock.html` Panel 3). Signs this account out and
// opens sign-in with preview-access as its `next`, so the other account comes
// straight back to the same preview. A ghost Button: the way out, never
// competing with "Go to Motir".
export function SwitchAccountButton({ label, next }: { label: string; next: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={isPending}
      onClick={() =>
        startTransition(async () => {
          await signOut();
          router.push(`/sign-in?${new URLSearchParams({ next }).toString()}`);
        })
      }
    >
      {label}
    </Button>
  );
}
