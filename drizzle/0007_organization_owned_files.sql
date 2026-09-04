-- files.entity_id becomes nullable, and NULL means the file belongs to the
-- tenant itself rather than to a record.
--
-- The logo is the case that forced this. `organization` has an integer primary
-- key by design (CHECK id = 1), so there is no UUID to point at, and the
-- upload path had to invent the nil UUID as a sentinel. A sentinel that means
-- "not really a reference" is the kind of value somebody later joins on: it
-- looks like an id, it is unique, and it points at nothing.
--
-- NULL says the same thing in the type system rather than in a comment. The
-- (entity_type, entity_id) index still serves the lookups that matter, because
-- entity_type alone already selects the organization's files.
alter table files alter column entity_id drop not null;
--> statement-breakpoint

-- Any rows written before this migration carried the sentinel.
update files
set entity_id = null
where entity_type = 'organization'
  and entity_id = '00000000-0000-0000-0000-000000000000';
