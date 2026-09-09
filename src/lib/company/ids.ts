/**
 * The company that existed before companies existed.
 *
 * A FIXED uuid rather than `gen_random_uuid()`, for the reason
 * `db/seed/project-lists.ts` and `db/seed/reminder-rules.ts` give for theirs:
 * the migration that creates this table has to stamp `projects.company_id`,
 * `tax_rates.company_id` and `document_sequences.company_id` on every existing
 * row, the demo seed has to point at it, and a test has to be able to name it.
 * A random id would make all three read the table back to find out what they
 * had just created.
 *
 * A SECOND company gets a random id. There is only ever one row that predates
 * the concept, and only that row needs a name in code.
 */
export const FIRST_COMPANY_ID = 'c0000001-0000-4a00-9000-000000000001';
