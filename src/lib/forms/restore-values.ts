/**
 * Writes a submitted FormData back into a form React has just blanked.
 *
 * React resets an uncontrolled form once its action settles, and it cannot know
 * the action REFUSED -- so a server-side "that customer is void" arrived with
 * every field wiped. The person was told what was wrong with work they could no
 * longer see, on forms running to a dozen fields. This puts it back.
 *
 * Lifted out of `ActionForm`, where it was written, because the record editors
 * now need it too: a fourteen-field job edit in a modal that empties itself on
 * a refusal is the same loss, over a page the person can no longer read either.
 * One copy rather than two that drift.
 *
 * Checkboxes are the case worth spelling out: an unchecked box sends NOTHING,
 * so its name is absent from the FormData entirely. Reading the entries alone
 * would leave a box the person had just UNticked still ticked, which is a
 * silent wrong answer rather than a visible blank. So every checkbox and radio
 * is cleared first and then set from what was actually sent.
 *
 * File inputs are skipped and cannot be otherwise: a browser refuses to let a
 * script set a file control's value, which is a security property and not a
 * limitation to work around. A refused form that had a file attached loses the
 * attachment, and that is worth knowing rather than pretending.
 */
export function restoreInto(form: HTMLFormElement, data: FormData | null): void {
  if (!data) return;

  for (const element of form.elements) {
    if (
      element instanceof HTMLInputElement
      && (element.type === 'checkbox' || element.type === 'radio')
    ) {
      element.checked = false;
    }
  }

  for (const [name, value] of data.entries()) {
    if (typeof value !== 'string') continue;
    const found = form.elements.namedItem(name);
    if (!found) continue;

    // A repeated name -- a checkbox group, or radios -- comes back as a
    // collection rather than one element.
    const controls = found instanceof RadioNodeList ? Array.from(found) : [found];
    for (const control of controls) {
      if (control instanceof HTMLInputElement) {
        if (control.type === 'file') continue;
        if (control.type === 'checkbox' || control.type === 'radio') {
          if (control.value === value) control.checked = true;
        } else {
          control.value = value;
        }
      } else if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        control.value = value;
      }
    }
  }
}
