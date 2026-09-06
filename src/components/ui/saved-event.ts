/**
 * The one name for "a write landed", shared by whoever announces it and
 * whoever listens.
 *
 * A DOM event rather than a prop or a context, because the forms that fire it
 * are server-rendered inside client shells that hold no state of theirs. A
 * sheet opened from a table row cannot be handed a result it never receives,
 * and threading one down would mean making every form on every settings page a
 * client component to solve a problem that belongs to the shell around them.
 *
 * A string constant rather than the literal at each site: a typo in an event
 * name is silent at compile time and at runtime, and the failure -- a sheet
 * that never closes -- looks exactly like the bug this was written to fix.
 */
export const SAVED_EVENT = 'scopeline:saved';

/** What rides along, so a banner can say what happened rather than "Done". */
export interface SavedEventDetail {
  message: string;
}

export type SavedEvent = CustomEvent<SavedEventDetail>;

/**
 * `SAVED_EVENT`'s sibling: a write that came back refused rather than one
 * that landed.
 *
 * Needed because a form and a `Sheet` around it disagree about whether a
 * refusal is "done" -- `ActionForm` already keeps the typed values on screen
 * (`restoreInto`, after React's own post-action reset), but the shell wrapping
 * it had no way to learn that a submit happened AND failed, only that a
 * submit happened. `SheetButton` is the first listener: without this it could
 * not tell "the fields match what was last submitted because it saved" apart
 * from "they match because a refused submit's own values were put back", and
 * the two must not be treated the same for the purpose of asking before a
 * dismissal throws work away.
 */
export const REFUSED_EVENT = 'scopeline:refused';

/** What rides along -- the refusal reason, for a listener that wants to say why. */
export interface RefusedEventDetail {
  message: string;
}

export type RefusedEvent = CustomEvent<RefusedEventDetail>;
