import { CheckboxField, type Option, SelectField, TextField } from '@/components/settings/Fields';
import { formatQty, formatRate } from '@/lib/money/format';
import { CALC_MODE_OPTIONS } from '@/app/rates/schema';

/**
 * The eleven fields a rate item is made of, shared by the add sheet and the
 * change sheet on `/rates`.
 *
 * Split out for the reason `TemplateLineFields` was: adding an item and
 * changing one were two hand-typed copies of the same fields, and the owner's
 * complaint about templates -- *"why are there 2 different components?
 * shouldn't this just be 1?"* -- applies here without changing a word. One
 * component, rendered from both forms, is what makes an improvement to a hint
 * or a validation message land in both places by construction.
 *
 * `code` is NOT add-only, unlike a template line's rate-item picker. It reads
 * as if it should be fixed once an item exists, but `updateRateItem` accepts
 * it -- `withId` is `rateItemFields.extend({ id })`, the exact same shape
 * `createRateItem` parses -- so the edit sheet has always let it be renamed,
 * and this component keeps that rather than assuming otherwise.
 *
 * A few hints read differently depending on which sheet is open even though
 * the field is the same one -- `calcMode`, `costRate` and `defaultQty` -- and
 * that difference is preserved here rather than picked one way, the same
 * choice `TemplateLineFields`' hint for a fixed quantity already made.
 */
export interface EditableRateItem {
  code: string;
  description: string;
  calcMode: 'qty' | 'flat' | 'percent';
  unitLabel: string;
  costRateTenThou: bigint;
  sellRateTenThou: bigint;
  costCodeId: string | null;
  defaultQtyMilli: bigint | null;
  sortOrder: number;
  isTaxable: boolean;
  isAllowance: boolean;
}

export function RateItemFields({
  idPrefix,
  item,
  costCodeOptions,
  costCodeHint,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new item wants. */
  item?: EditableRateItem;
  /**
   * The cost codes this item may be filed under. Not the same list for both
   * callers: the add sheet offers only the live, active ones, while the
   * change sheet's caller adds back whatever code the item is already
   * carrying, retired or voided, so a `<select>` never silently refiles a row
   * nobody asked to move.
   */
  costCodeOptions: Option[];
  /** Set only by the change sheet, when the item's current code is retired or voided. */
  costCodeHint?: string;
  disabled: boolean;
}) {
  return (
    <>
      <TextField
        idPrefix={idPrefix}
        name="code"
        label="Code"
        required
        maxLength={60}
        defaultValue={item?.code}
        disabled={disabled}
        hint="Unique across the one list."
      />
      <TextField
        idPrefix={idPrefix}
        name="description"
        label="Description"
        required
        maxLength={500}
        defaultValue={item?.description}
        disabled={disabled}
        hint="What a quote line says by default."
      />
      <SelectField
        idPrefix={idPrefix}
        name="calcMode"
        label="How it calculates"
        required
        defaultValue={item?.calcMode ?? 'qty'}
        options={CALC_MODE_OPTIONS}
        disabled={disabled}
        hint={
          item ? undefined : 'Quantity multiplies; flat ignores quantity; percent applies to another figure.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="unitLabel"
        label="Unit"
        maxLength={20}
        defaultValue={item?.unitLabel}
        disabled={disabled}
        hint="Display only — sqft, lnft, ea, hr. It never affects the arithmetic."
      />
      <TextField
        idPrefix={idPrefix}
        name="costRate"
        label="Cost"
        numeric
        inputMode="decimal"
        maxLength={20}
        defaultValue={item ? formatRate(item.costRateTenThou) : undefined}
        disabled={disabled}
        hint={
          item
            ? 'What it costs you. Never printed on a customer document.'
            : 'To four decimals. Blank records as zero, and the margin will read 100%.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="sellRate"
        label="Sell"
        required
        numeric
        inputMode="decimal"
        maxLength={20}
        defaultValue={item ? formatRate(item.sellRateTenThou) : undefined}
        disabled={disabled}
        hint="Negative is allowed, and is how a discount line is written."
      />
      <SelectField
        idPrefix={idPrefix}
        name="costCodeId"
        label="Cost code"
        defaultValue={item?.costCodeId ?? null}
        options={costCodeOptions}
        blankLabel="Not costed"
        disabled={disabled}
        hint={costCodeHint}
      />
      <TextField
        idPrefix={idPrefix}
        name="defaultQty"
        label="Default quantity"
        numeric
        inputMode="decimal"
        maxLength={20}
        defaultValue={item?.defaultQtyMilli != null ? formatQty(item.defaultQtyMilli) : undefined}
        disabled={disabled}
        hint={
          item
            ? 'Filled in when added to a quote; blank to type one each time.'
            : 'Optional, never negative — a reduction is typed as a negative price.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        numeric
        inputMode="numeric"
        maxLength={6}
        defaultValue={String(item ? item.sortOrder : 0)}
        disabled={disabled}
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="isTaxable"
        label="Tax applies to this item"
        defaultChecked={item ? item.isTaxable : true}
        disabled={disabled}
        hint="Off for a pass-through such as a municipal permit fee."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="isAllowance"
        label="This is an allowance"
        defaultChecked={item?.isAllowance}
        disabled={disabled}
        hint="A placeholder the customer can spend, reconciled against actual cost later."
      />
    </>
  );
}
