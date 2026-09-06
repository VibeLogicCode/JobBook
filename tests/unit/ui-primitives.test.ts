import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonClass } from '@/components/ui/Button';
import { isDirty, openBaseline, refused, submitted } from '@/components/ui/dirty-baseline';
import { fillPercent } from '@/components/ui/ProgressBar';

const UI_DIR = path.resolve(import.meta.dirname, '../../src/components/ui');

/**
 * There is no DOM in this suite (`environment: 'node'`, and no renderer is
 * installed), so what is tested here is what can be tested without one: the
 * two pure functions the primitives compute their output from, and the two
 * rules about the primitives' source that a screenshot cannot prove.
 *
 * A screenshot proves a colour is right in the theme it was taken in. It
 * cannot prove the colour came from the token layer, which is the property
 * that makes the OTHER theme right -- so that one is checked by reading the
 * files.
 */

describe('buttonClass', () => {
  it('sizes to its content by default', () => {
    // The owner has objected twice to a button spanning a desk monitor.
    // `inline-flex` alone does not hold this: a grid or flex-column parent
    // stretches its items, which is how it happened both times.
    expect(buttonClass()).toContain('w-fit');
    expect(buttonClass()).not.toContain('w-full');
  });

  it('goes full width only when asked', () => {
    const full = buttonClass('primary', { fullWidth: true });
    expect(full).toContain('w-full');
    // Both would land in the class list and the winner would be decided by
    // the order Tailwind emitted the rules in, not by this call.
    expect(full).not.toContain('w-fit');
  });

  it('never falls below the 44px touch target, and reaches 48px on request', () => {
    expect(buttonClass()).toContain('min-h-11');
    expect(buttonClass('primary', { size: 'lg' })).toContain('min-h-12');
  });

  it('keeps controls off paper', () => {
    // The document a customer receives comes from the print route; a button
    // printed onto it is ink spent on something nobody can press.
    expect(buttonClass()).toContain('no-print');
  });

  it('gives each variant its own token family', () => {
    expect(buttonClass('primary')).toContain('bg-accent');
    expect(buttonClass('secondary')).toContain('border-line-strong');
    expect(buttonClass('danger')).toContain('border-negative');
  });

  it('appends the caller class last so it can override', () => {
    expect(buttonClass('primary', { className: 'ml-auto' }).endsWith('ml-auto')).toBe(true);
  });
});

describe('the dirty baseline SheetButton drives from DOM events', () => {
  // No DOM appears anywhere here: `openBaseline`/`submitted`/`refused`/
  // `isDirty` are plain functions over strings, which is the whole point of
  // pulling them out of `SheetButton` -- this suite runs in `environment:
  // 'node'` with no renderer, so a component-level test of the actual bug
  // is not available, and a rule about event ORDER is worth a test that does
  // not need one.

  it('is not dirty right after the sheet opens', () => {
    const baseline = openBaseline('name=Framing');
    expect(isDirty(baseline, 'name=Framing')).toBe(false);
  });

  it('is dirty once the live fields diverge from the open-time snapshot', () => {
    const baseline = openBaseline('name=Framing');
    expect(isDirty(baseline, 'name=Framing (revised)')).toBe(true);
  });

  it('THE BUG: without the fix, a refusal reads as clean', () => {
    // This is the fault on record: `submitted` alone re-baselines the
    // instant a submit fires, before anything knows the server will refuse
    // it. `ActionForm`'s `restoreInto` then puts the typed value back onto
    // the field -- to the exact string `submitted` already captured -- so a
    // dismissal compared the live fields against themselves and always found
    // them equal, no matter that nothing was ever saved.
    const opened = openBaseline('name=Framing');
    const atSubmit = submitted(opened, 'name=Framing (revised)');
    const liveAfterRestore = 'name=Framing (revised)'; // what restoreInto put back
    expect(isDirty(atSubmit, liveAfterRestore)).toBe(false); // the bug, demonstrated
  });

  it('THE FIX: a refused submit leaves the sheet dirty', () => {
    const opened = openBaseline('name=Framing');
    const atSubmit = submitted(opened, 'name=Framing (revised)');
    const afterRefusal = refused(atSubmit);
    const liveAfterRestore = 'name=Framing (revised)'; // restoreInto puts the typed value back
    // A dismissal now compares the restored field against the sheet's
    // OPEN-time value, not against the value the failed submit captured --
    // so it reads as dirty and a discard prompt asks, exactly as it would
    // have before any submit was attempted.
    expect(isDirty(afterRefusal, liveAfterRestore)).toBe(true);
  });

  it('rolls back only the submit being refused, not further', () => {
    // A second attempt, refused a second time, must not unwind all the way
    // to the sheet's original open-time value if the person had already
    // fixed part of the form in between -- only the one submit in flight is
    // undone.
    const opened = openBaseline('name=Framing');
    const firstAttempt = refused(submitted(opened, 'name=Framing (typo)'));
    const secondAttempt = refused(submitted(firstAttempt, 'name=Framing (fixed)'));
    expect(secondAttempt).toEqual(opened);
    expect(isDirty(secondAttempt, 'name=Framing (fixed)')).toBe(true);
  });

  it('a refusal with no submit in flight is a no-op', () => {
    const opened = openBaseline('name=Framing');
    expect(refused(opened)).toEqual(opened);
  });
});

describe('fillPercent', () => {
  it('passes an ordinary percentage through', () => {
    expect(fillPercent(42)).toBe(42);
  });

  it('clamps a fill past the limit without touching what is reported', () => {
    // Over-invoiced at 112% draws a full bar. `aria-valuenow` still says 112,
    // and the figure beside the bar says by how much -- the bar only ever
    // says "past the limit", so nothing is lost by clamping it.
    expect(fillPercent(112)).toBe(100);
  });

  it('clamps a negative to zero rather than drawing a bar backwards', () => {
    expect(fillPercent(-8)).toBe(0);
  });

  it('treats an undefined division as zero', () => {
    // 0/0 is what a percentage against a contract value of nothing produces,
    // and a NaN width silently drops the fill element out of the layout.
    expect(fillPercent(Number.NaN)).toBe(0);
    expect(fillPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

async function primitiveSources(): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(UI_DIR)).filter((name) => name.endsWith('.tsx'));
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(path.join(UI_DIR, name), 'utf8'),
    })),
  );
}

describe('the primitives themselves', () => {
  it('names no colour that the token layer does not own', async () => {
    // A raw hex or rgb() is correct in exactly one theme. Both themes are
    // real here -- the dark one is what a 6am truck cab uses -- and the
    // tenant's accent is a one-value change in globals.css, which only works
    // while every component asks for the token instead of the value.
    const offences = (await primitiveSources())
      .filter(({ text }) => /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/i.test(text))
      .map(({ name }) => name);
    expect(offences).toEqual([]);
  });

  it('never animates without saying what a reduced-motion reader gets instead', async () => {
    // A spinner is motion. Somebody who has asked their operating system for
    // less of it is entitled to a busy indication, not to nothing -- so every
    // animated element here pairs its animation with the reduced-motion case
    // rather than relying on a global rule in a file three directories away.
    const offences = (await primitiveSources())
      .filter(({ text }) => text.includes('animate-spin') && !text.includes('motion-reduce:'))
      .map(({ name }) => name);
    expect(offences).toEqual([]);
  });

  it('leaves the button pending prop undefaulted, which is what reserves the spinner', async () => {
    // The pending and idle labels are stacked in one grid cell so the button
    // cannot change width as it goes busy -- a control that resizes under the
    // pointer is a control the second press misses. Passing `pending` at all
    // is what opts into that reserved width, so a default of `false` would
    // silently widen every button in the product by a spinner.
    const button = (await primitiveSources()).find(({ name }) => name === 'Button.tsx');
    expect(button?.text).not.toContain('pending = false');
  });

  it('leaves no primitive without its reasoning', async () => {
    // The comments are the part of this port that was worth carrying. A file
    // that arrives here with none is a file the next person will rewrite from
    // scratch rather than trust.
    const bare = (await primitiveSources())
      .filter(({ text }) => !text.includes('/**'))
      .map(({ name }) => name);
    expect(bare).toEqual([]);
  });
});
