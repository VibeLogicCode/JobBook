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
