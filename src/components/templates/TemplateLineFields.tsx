import { CheckboxField, SelectField, TextField } from '@/components/settings/Fields';
import { formatQty, formatRate } from '@/lib/money/format';
import type { QtySource } from '@/lib/quote/template';
import { QTY_SOURCE_OPTIONS } from '@/app/templates/schema';

/**
 * The seven fields that describe a template LINE'S RULE rather than which item
 * it names.
 *
 * Split out for the reason `TaskFields` (`src/components/schedule/TaskEditor.tsx`)
 * was: adding a line and changing one used to be two hand-typed copies of the
 * same six fields, and the owner's complaint was exactly that they were two
 * components at all -- *"why are there 2 different components? shouldn't this
 * just be 1?"* One component, rendered from both forms, is what makes an
 * improvement to a hint or a validation message land in both places by
 * construction rather than by remembering the other call site.
 *
 * The rate item itself is NOT here. Adding a line picks one; changing a line
 * cannot repoint it to a different item, so that select stays with the add
 * form alone and this component only ever edits the rule sitting on top of it.
 *
 * Renders a bare fragment, like `TaskFields` -- the caller supplies the
 * `FieldGrid`, so the add form can put its rate-item select in the same grid
 * as these fields rather than opening a second one underneath it.
 */
export interface EditableTemplateLine {
  qtySource: QtySource;
  qtyMultiplierTenThou: string;
  fixedQtyMilli: string | null;
  lineGroup: string;
  sortOrder: number;
  isOptional: boolean;
  isAllowance: boolean;
}

export function TemplateLineFields({
  idPrefix,
  line,
  nextSortOrder,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new line wants. */
  line?: EditableTemplateLine;
  /** Only read when `line` is absent -- the add form's next free slot. */
  nextSortOrder?: number;
  disabled: boolean;
}) {
  return (
    <>
      <SelectField
        idPrefix={idPrefix}
        name="qtySource"
        label="Quantity from"
        required
        defaultValue={line?.qtySource ?? 'area'}
        options={QTY_SOURCE_OPTIONS}
        disabled={disabled}
      />
      <TextField
        idPrefix={idPrefix}
        name="qtyMultiplier"
        label="Multiplier"
        required
        numeric
        inputMode="decimal"
        maxLength={12}
        defaultValue={line ? formatRate(BigInt(line.qtyMultiplierTenThou)) : '1'}
        disabled={disabled}
        hint="1 is one unit per source unit; 0.02 is one per fifty. Ignored when typed on the quote."
      />
      <TextField
        idPrefix={idPrefix}
        name="fixedQty"
        label="Fixed quantity"
        numeric
        inputMode="decimal"
        maxLength={12}
        defaultValue={line?.fixedQtyMilli != null ? formatQty(BigInt(line.fixedQtyMilli)) : ''}
        disabled={disabled}
        hint="Only read when the source above is a fixed quantity."
      />
      <TextField
        idPrefix={idPrefix}
        name="lineGroup"
        label="Line group"
        required
        maxLength={100}
        defaultValue={line?.lineGroup}
        disabled={disabled}
        hint="Usually the trade. It bands the worksheet and groups the document."
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        required
        numeric
        inputMode="numeric"
        maxLength={4}
        defaultValue={String(line ? line.sortOrder : (nextSortOrder ?? 0))}
        disabled={disabled}
        hint="In steps of ten, so a line can be inserted without renumbering."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="isOptional"
        label="Optional — an upgrade the customer may add"
        defaultChecked={line?.isOptional}
        disabled={disabled}
        hint="Starts excluded, so a template cannot silently inflate a quote."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="isAllowance"
        label="Allowance — a placeholder reconciled against actual cost"
        defaultChecked={line?.isAllowance}
        disabled={disabled}
        hint="Overrides the rate item's own allowance flag for this template only."
      />
    </>
  );
}
