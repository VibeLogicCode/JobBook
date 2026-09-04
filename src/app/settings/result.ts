/**
 * The result every settings and template action returns.
 *
 * Actions return this instead of throwing. A thrown error in a server action
 * reaches the browser as an opaque digest -- "an error occurred in the Server
 * Components render" -- which tells the owner nothing about the postal code he
 * mistyped, and in production strips the message entirely. A typed result
 * carries the sentence he needs to read.
 */

export interface FieldError {
  /** The form control's `name`, so the field can be marked invalid. */
  field: string;
  /** What the field is called on screen, for the error summary. */
  label: string;
  message: string;
}

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: FieldError[] };

/**
 * The shape `useActionState` needs. The previous result is passed in and
 * ignored by every action here: a settings form is a full-record submit, so
 * there is no partial state to carry forward.
 */
export type FormAction = (
  previous: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

export function saved(message: string): ActionResult {
  return { ok: true, message };
}

export function refused(error: string, fieldErrors?: FieldError[]): ActionResult {
  return { ok: false, error, fieldErrors };
}
