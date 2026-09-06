import { type Option, SelectField, TextField } from '@/components/settings/Fields';
import { CATEGORY_OPTIONS, isCategory } from '@/app/settings/cost-codes/schema';

/**
 * The five fields a cost code is made of, shared by the add sheet and the
 * change sheet on `/settings/cost-codes`.
 *
 * Split out for the reason `TemplateLineFields` was -- see that component's
 * doc comment. Every hint here reads differently depending on which sheet is
 * open, because a code that already exists is being explained to someone
 * reading what it already does, and a code that does not yet exist is being
 * explained to someone deciding whether to make it -- so the wording is kept
 * per caller rather than forced to agree, the same choice `RateItemFields`
 * made for `calcMode`, `costRate` and `defaultQty`.
 */
export interface EditableCostCode {
  code: string;
  name: string;
  parentId: string | null;
  category: string | null;
  sortOrder: number;
}

export function CostCodeFields({
  idPrefix,
  row,
  parentOptions,
  parentDisabled,
  parentHint,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new code wants. */
  row?: EditableCostCode;
  /**
   * The divisions this code may sit under. Not the same list for both
   * callers -- the change sheet excludes the row itself and adds back
   * whatever division it already sits under, retired or voided, so a
   * `<select>` never silently refiles a code nobody asked to move.
   */
  parentOptions: Option[];
  /** Set only by the change sheet, when the code has sections under it. */
  parentDisabled?: boolean;
  /** Set only by the change sheet, when the code has sections under it. */
  parentHint?: string;
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
        defaultValue={row?.code}
        disabled={disabled}
        hint={
          row
            ? "Unique, stored upper case. Renaming doesn't orphan anything already filed."
            : // A comma or a pipe breaks the price-list importer, which
              // splits a pasted line on exactly those.
              'Letters, digits and . - _ / only, in upper case.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="name"
        label="Name"
        required
        maxLength={200}
        defaultValue={row?.name}
        disabled={disabled}
        hint={
          row
            ? 'What this bucket is called on a report.'
            : 'The trade or the bucket, in the words you would use on a report.'
        }
      />
      <SelectField
        idPrefix={idPrefix}
        name="parentId"
        label="Sits under"
        defaultValue={row?.parentId ?? null}
        options={parentOptions}
        blankLabel="Nothing — this is a division"
        disabled={disabled || Boolean(parentDisabled)}
        hint={
          parentHint ??
          (row
            ? 'Two levels only. A section cannot hold sections of its own.'
            : 'Leave it a division unless one has grown too broad to code against.')
        }
      />
      <SelectField
        idPrefix={idPrefix}
        name="category"
        label="Spend category"
        defaultValue={row ? (isCategory(row.category) ? row.category : '') : undefined}
        options={CATEGORY_OPTIONS}
        blankLabel="Not categorised"
        disabled={disabled}
        hint={
          row
            ? 'What a year-end export groups by, above the code itself.'
            : 'Chosen from a list, so an export never reports Labour and labour as two things.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        numeric
        inputMode="numeric"
        maxLength={6}
        defaultValue={String(row ? row.sortOrder : 0)}
        disabled={disabled}
        hint="Within its division. Equal numbers fall back to the code."
      />
    </>
  );
}
