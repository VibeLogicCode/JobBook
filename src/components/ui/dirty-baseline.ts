/**
 * `SheetButton`'s dirty check, as plain state transitions -- no DOM, no React.
 *
 * Pulled out on its own because the bug it fixes is a rule about ORDER, and a
 * rule about order is exactly the kind of thing that reads as correct in the
 * component and is wrong in a way no screenshot catches. `SheetButton`
 * re-baselines the moment a submit fires, eagerly, before anything knows
 * whether the server will accept it -- because a save is the common case, and
 * waiting for confirmation would be one tick too late for a sheet that closes
 * itself the instant a save is confirmed. A REFUSAL used to leave that eager
 * guess standing: the fields get their typed values put back
 * (`ActionForm`'s `restoreInto`), the snapshot taken at submit already equals
 * that restored snapshot, and a dismissal read the two as equal -- clean --
 * and closed without asking, discarding a save that never happened.
 *
 * The fix is not "stop re-baselining on submit" -- that would leave a sheet
 * whose children never fire `REFUSED_EVENT` at all (nothing here assumes
 * every caller wraps an `ActionForm`) with no baseline update ever, which
 * is the ORIGINAL bug this codebase already fixed once, in the other
 * direction. It is "undo exactly the guess that turned out wrong", which is
 * what `refused` below does: it restores `current` to what it was
 * immediately before the submit that is being refused, not to the sheet's
 * original open-time value -- so a second failed attempt after a first
 * correctly unwinds to the value before ITS OWN submit, not further back.
 *
 * No DOM appears anywhere in this file on purpose: this repo's test
 * environment is `node`, with no renderer installed, and a rule worth this
 * comment is worth a test that does not need one.
 */
export interface DirtyBaseline {
  /** What a dismissal compares the live fields against right now. */
  current: string;
  /** What `current` held immediately before the submit in flight, if any --
   *  restored if that submit comes back refused. */
  beforeSubmit: string;
}

/** The sheet has just opened (or re-opened for a different row): both sides
 *  start at the fields' own starting values, so nothing reads as dirty yet. */
export function openBaseline(snapshotAtOpen: string): DirtyBaseline {
  return { current: snapshotAtOpen, beforeSubmit: snapshotAtOpen };
}

/** The eager guess made the instant a submit fires: assume it is a save,
 *  and remember what to fall back to if that guess is wrong. */
export function submitted(state: DirtyBaseline, snapshotAtSubmit: string): DirtyBaseline {
  return { current: snapshotAtSubmit, beforeSubmit: state.current };
}

/** The guess proven wrong. Rolls `current` back to `beforeSubmit`; a second
 *  refusal in a row is then a no-op, which is the correct answer -- there is
 *  only ever one submit's worth of guess to undo. */
export function refused(state: DirtyBaseline): DirtyBaseline {
  return { current: state.beforeSubmit, beforeSubmit: state.beforeSubmit };
}

/** Whether the live fields (as `fieldSnapshot` reads them right now) differ
 *  from what this baseline currently calls "clean". */
export function isDirty(state: DirtyBaseline, liveSnapshot: string): boolean {
  return liveSnapshot !== state.current;
}
