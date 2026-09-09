'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { generateBackupKey, type BackupKeyResult } from '@/app/settings/backup/actions';
import { Button, buttonClass } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';

/**
 * Generates a backup keypair and shows the private half exactly once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CLIENT COMPONENT WHEN ALMOST NOTHING ELSE HERE IS
 * ---------------------------------------------------------------------------
 *
 * The settings area is server-rendered on purpose. This screen cannot be,
 * because "shown once and never again" is a property of where the value LIVES:
 * the private key arrives in the action's return value and sits in this
 * component's state, in the browser's memory. Navigate away or reload and it
 * is gone, because there is nowhere it could be fetched from again.
 *
 * A server-rendered version would need somewhere to read the key from between
 * the POST and the render, and every candidate -- a database row, a file, a
 * cookie, a cache -- is the thing this must not do.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ACKNOWLEDGEMENT IS NOT SECURITY
 * ---------------------------------------------------------------------------
 *
 * The "I have saved this key" checkbox does not protect anything -- it cannot,
 * the key is already generated and in use. It exists to make the operator
 * stop and read one sentence, because the failure it guards against is
 * inattention rather than malice: a person who closes this panel without
 * copying the key has silently made every future backup unreadable, and
 * nothing anywhere will tell him until he needs one.
 */
export function KeyReveal({ hasKey }: { hasKey: boolean }) {
  const [state, formAction] = useActionState<BackupKeyResult | null, FormData>(
    generateBackupKey,
    null,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  if (state?.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="warning" title="Copy this key now. It will not be shown again.">
          This is the only copy. It is not saved on this machine — deliberately, because a
          machine that holds both halves gives up nothing when it is stolen. Without this key,
          every backup taken from now on is permanently unreadable, including by the person who
          wrote this software.
        </Notice>

        <div className="flex flex-col gap-2">
          <p className="t-small font-semibold">Private key — keep this somewhere safe</p>
          {/*
            * `readOnly` rather than disabled: a disabled control is not
            * selectable, and selecting the text by hand is the fallback when
            * the clipboard is refused — which it is on a plain-HTTP LAN
            * origin in some browsers, i.e. exactly this deployment.
            */}
          <textarea
            readOnly
            rows={2}
            value={state.privateKey}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-control border border-line-strong bg-surface-2 p-3 num text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(state.privateKey)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
            <button type="button" className={buttonClass()} onClick={() => window.print()}>
              Print this page
            </button>
          </div>
          {copied ? null : (
            <p className="t-small text-muted">
              If the copy button does nothing, select the text above and copy it by hand —
              browsers refuse the clipboard on some plain-HTTP addresses.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="t-small font-semibold">Public key — already saved on this machine</p>
          <p className="num break-all t-small text-muted">{state.publicKey}</p>
        </div>

        {state.replaced ? (
          <Notice tone="warning" title="This replaced an earlier key">
            Backups taken before now are still encrypted to the OLD key and can only be opened
            with the old private half. Keep both, or those backups become unreadable.
          </Notice>
        ) : null}

        <label className="flex items-start gap-2 t-small">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            className="mt-1"
          />
          <span>
            I have saved this key somewhere that is not this machine.
          </span>
        </label>

        {acknowledged ? (
          <Notice tone="positive" title="Backups are configured">
            The next scheduled run will encrypt to this key. Nothing else is needed.
          </Notice>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state?.ok === false ? <Notice tone="negative">{state.error}</Notice> : null}

      <label className="flex flex-col gap-1">
        <span className="t-small font-semibold">
          Type <span className="num">generate</span> to confirm
        </span>
        <input
          name="confirm"
          autoComplete="off"
          spellCheck={false}
          className="max-w-xs rounded-control border border-line-strong bg-surface p-2"
        />
        <span className="t-small text-muted">
          {hasKey
            ? 'A new key replaces the one this machine encrypts to. Old backups keep needing the old key.'
            : 'The private half is shown once, on the next screen, and never stored.'}
        </span>
      </label>

      <Generate hasKey={hasKey} />
    </form>
  );
}

function Generate({ hasKey }: { hasKey: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Generating…' : hasKey ? 'Generate a replacement key' : 'Generate a backup key'}
    </Button>
  );
}
