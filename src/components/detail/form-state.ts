/**
 * The contract between the forms in this directory and the server actions
 * behind them.
 *
 * Shaped for `useActionState`, so every form works before its JavaScript has
 * loaded: the browser posts the form, the action validates and answers, and the
 * answer renders. A form that only submits through an onClick handler is a form
 * that does nothing on a phone with a half-loaded page in a basement.
 */
export type FormResult = { ok: true } | { ok: false; error: string };

/**
 * A create action redirects on success and so never returns; an edit or a void
 * returns a result. `never` on the redirect path is why the return type is not
 * simply `FormResult`.
 */
export type FormAction = (
  state: FormResult | null,
  formData: FormData,
) => Promise<FormResult>;
