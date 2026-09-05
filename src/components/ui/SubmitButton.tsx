'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui/Button';

/**
 * The submit button for a form the BROWSER posts -- `<form method="get">`,
 * which is how the filter bar and the billing preview work.
 *
 * `useFormStatus` reports nothing for those. React only tracks a form whose
 * `action` is a function; a form with a string action and a method is a plain
 * document navigation that React never sees, so every other submit in this
 * product gets a spinner from the hook and these two got none. They are still
 * a round trip to the server, and the owner's rule does not have an exception
 * for reads.
 *
 * The busy state is set from the form's own `submit` event rather than from
 * the button's `onClick`. That ordering is the whole trick: React flushes a
 * click's state update synchronously, so disabling the button in `onClick`
 * disables it BEFORE the browser gets to the default action and the form never
 * posts at all. By `submit` the browser has already built the request, and
 * disabling the button cannot call it back.
 */
export function SubmitButton({
  pendingLabel,
  children,
  ...rest
}: Omit<ButtonProps, 'type' | 'pending' | 'ref'>) {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;

    const started = () => setBusy(true);
    // Back button. A page restored from the browser's cache comes back as the
    // DOM was left -- which, after a search, is a disabled button spinning at
    // a screen that has already finished loading.
    const restored = () => setBusy(false);

    form.addEventListener('submit', started);
    window.addEventListener('pageshow', restored);
    return () => {
      form.removeEventListener('submit', started);
      window.removeEventListener('pageshow', restored);
    };
  }, []);

  return (
    <Button {...rest} ref={ref} type="submit" pending={busy} pendingLabel={pendingLabel}>
      {children}
    </Button>
  );
}
