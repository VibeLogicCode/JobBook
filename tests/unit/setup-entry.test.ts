import { describe, expect, it } from 'vitest';
import { firstRunDestination } from '@/app/setup/entry';
import type { SetupGate } from '@/app/setup/state';

/**
 * Nothing outside the wizard linked to `/setup`.
 *
 * The nine steps existed, worked, and were reachable only by typing the URL --
 * every `setupHref` call site was inside the wizard itself. A fresh
 * deployment therefore rendered "Setup required" and stopped, and the owner of
 * one could not start. This is the function that decides whether `/` hands
 * somebody to the wizard instead.
 */

describe('firstRunDestination', () => {
  it('sends an unfinished deployment to the step it left off at', () => {
    const gate = {
      open: true,
      org: null,
      completed: new Set(['company', 'contact'] as const),
      resumeAt: 'locale',
      values: new Map(),
    } as unknown as SetupGate;

    expect(firstRunDestination(gate)).toBe('/setup/locale');
  });

  it('starts at the first step when nothing is finished', () => {
    const gate = {
      open: true,
      org: null,
      completed: new Set(),
      resumeAt: 'company',
      values: new Map(),
    } as unknown as SetupGate;

    expect(firstRunDestination(gate)).toBe('/setup/company');
  });

  it('leaves a finished deployment alone', () => {
    const gate = { open: false, reason: 'complete', detail: '' } as SetupGate;
    expect(firstRunDestination(gate)).toBeNull();
  });

  it('leaves a company this wizard did not create alone', () => {
    // The dangerous branch. Redirecting here would walk a live tenant's owner
    // into forms that would replace his legal name and tax registration.
    const gate = { open: false, reason: 'live-tenant', detail: '' } as SetupGate;
    expect(firstRunDestination(gate)).toBeNull();
  });

  it('does not treat an unreadable database as a fresh install', () => {
    // A database that does not answer must never read as "nobody has claimed
    // this deployment yet". `/` keeps failing the way it already fails.
    const gate = { open: false, reason: 'unreachable', detail: 'timeout' } as SetupGate;
    expect(firstRunDestination(gate)).toBeNull();
  });
});
