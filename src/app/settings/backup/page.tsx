import type { Metadata } from 'next';
import { KeyReveal } from '@/app/settings/backup/KeyReveal';
import { can, resolveActor } from '@/app/settings/actor';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { isAgeRecipient } from '@/lib/backup/age-key';
import { authConfigPath, readAuthConfig } from '@/lib/deploy/auth-config';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Backups' };

/**
 * Where a backup key comes from.
 *
 * The runbook used to say "run `age-keygen` on another machine". Correct, and
 * almost nobody does it -- the first real install ran with no key, took no
 * backups, and said so only in a container log nobody had reason to open.
 * This screen is that instruction turned into a button.
 *
 * What it deliberately does NOT do is tell the operator his backups are
 * working. It knows a recipient is configured; whether a dump has ever
 * succeeded is a different question, answered by the artifacts and by
 * `sync_state`, and claiming otherwise here would be the same false
 * reassurance as a healthcheck that returns 200 without touching the
 * database.
 */
export default async function BackupSettingsPage() {
  const { actor, reason } = await resolveActor();
  const mayConfigure = actor !== null && can(actor.role, 'backup.configure');

  const file = await readAuthConfig();
  const configured = file?.entries.get('BACKUP_AGE_PUBLIC_KEY') ?? null;
  const fromEnvironment = process.env.BACKUP_AGE_PUBLIC_KEY ?? null;

  // The environment WINS over the file -- `read-config.sh` only exports a key
  // the environment does not already have. So an operator who set this in
  // compose is not looking at the value this screen would write, and saying
  // otherwise would be a lie about which key his backups use.
  const effective = fromEnvironment || configured;
  const overridden = Boolean(fromEnvironment && configured && fromEnvironment !== configured);

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Backups"
        description={
          <p>
            Every backup is encrypted to a key this machine cannot decrypt with. That is the
            point: a stolen NAS yields ciphertext. It also means the private half has to live
            somewhere else, and losing it is unrecoverable.
          </p>
        }
      >
        <div className="flex flex-col gap-4">
          {effective ? (
            <>
              <Notice tone="positive" title="A backup key is configured">
                Backups are encrypted to the key below. This screen cannot tell you whether a
                dump has actually succeeded — the backup artifacts and their timestamps are
                what answer that.
              </Notice>
              <div className="flex flex-col gap-1">
                <p className="t-small font-semibold">Public key in use</p>
                <p className="num break-all t-small text-muted">{effective}</p>
                <p className="t-small text-muted">
                  {fromEnvironment
                    ? 'Set in this container’s environment, which wins over the configuration file.'
                    : `Read from ${authConfigPath()}.`}
                </p>
              </div>
              {isAgeRecipient(effective) ? null : (
                <Notice tone="negative" title="That key is not a valid age recipient">
                  The backup process will refuse to run and exit rather than write something it
                  cannot encrypt. Generate a key below, or correct the value.
                </Notice>
              )}
              {overridden ? (
                <Notice tone="warning" title="Two different keys are configured">
                  The environment sets one key and {authConfigPath()} holds another. The
                  environment wins, so the file’s key is not in use. Generating a new key here
                  writes the file and will still be overridden until the environment value is
                  removed.
                </Notice>
              ) : null}
            </>
          ) : (
            <Notice tone="negative" title="This deployment is taking NO backups">
              No key is configured, so there is nothing to encrypt a dump to and the backup
              process exits rather than writing one. Nothing is being kept.
            </Notice>
          )}

          {mayConfigure ? (
            <KeyReveal hasKey={Boolean(effective)} />
          ) : (
            <Notice tone="warning">
              {reason ?? 'Your role does not permit changing how backups are encrypted.'}
            </Notice>
          )}
        </div>
      </Section>

      <Section
        title="What to do with the private key"
        description={
          <p>
            Read this before generating one. It is the part that cannot be fixed afterwards.
          </p>
        }
      >
        <ul className="flex flex-col gap-2 t-small text-muted">
          <li>
            <span className="font-semibold text-ink">Keep it off this machine.</span> A password
            manager, and a printed copy somewhere a fire would not reach both. Storing it on the
            NAS defeats the encryption entirely.
          </li>
          <li>
            <span className="font-semibold text-ink">Nobody can recover it for you.</span> Not
            the person who wrote this software. There is no escrow copy, by design.
          </li>
          <li>
            <span className="font-semibold text-ink">A new key does not break old backups.</span>{' '}
            They stay encrypted to the key that was in use when they were taken, so keep every
            key you have ever generated for as long as you keep backups made with it.
          </li>
          <li>
            <span className="font-semibold text-ink">Test it once.</span> A backup key you have
            never restored from is a guess. The restore procedure is in the deployment README.
          </li>
        </ul>
      </Section>
    </div>
  );
}
