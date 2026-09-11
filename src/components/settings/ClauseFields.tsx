import { SelectField, TextAreaField, TextField } from '@/components/settings/Fields';
import {
  CLAUSE_KIND_LABELS,
  CLAUSE_KIND_SUMMARIES,
  CLAUSE_KINDS,
  type ClauseKind,
} from '@/app/settings/clauses/schema';

export interface EditableClause {
  kind: ClauseKind;
  clauseText: string;
  sortOrder: number;
}

/**
 * The three fields a saved clause is made of, shared by the add sheet and the
 * change sheet on `/settings/clauses`, for the same reason
 * `LineGroupFields` is shared between its two.
 */
export function ClauseFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding. */
  row?: EditableClause;
  disabled: boolean;
}) {
  return (
    <>
      <SelectField
        idPrefix={idPrefix}
        name="kind"
        label="Kind"
        required
        // `exclusion` first and by default: it is the one that settles
        // arguments, and the one most people have a list of already.
        defaultValue={row?.kind ?? 'exclusion'}
        disabled={disabled}
        options={CLAUSE_KINDS.map((kind) => ({
          value: kind,
          label: `${CLAUSE_KIND_LABELS[kind]} — ${CLAUSE_KIND_SUMMARIES[kind]}`,
        }))}
        wide
      />
      <TextAreaField
        idPrefix={idPrefix}
        name="clauseText"
        label="Wording"
        required
        rows={2}
        defaultValue={row?.clauseText}
        disabled={disabled}
        hint="One line, as it should read on the quote. Write it the way you would say it to a customer."
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
        hint="Where it sits in the list on a quote. Equal numbers fall back to the wording."
      />
    </>
  );
}
