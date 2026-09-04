-- Mutability is defined by status and enforced here rather than in the
-- application (spec section 5.4). A draft is freely editable; once a quote has
-- been sent, declined, superseded or accepted, its priced content is a record
-- of what the customer saw.
--
-- Enforced in the database because the alternative is trusting every future
-- code path -- an API route, a migration, a bulk fix run by hand at 11pm --
-- to remember a rule about a document somebody has already signed.

create or replace function guard_quote_line_mutability() returns trigger as $$
declare
  parent_status text;
  row_id uuid := coalesce(new.id, old.id);
  parent_id uuid := coalesce(new.quote_id, old.quote_id);
begin
  select status into parent_status from quotes where id = parent_id;
  if parent_status is null or parent_status = 'draft' then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    raise exception 'quote % is % and cannot take new lines', parent_id, parent_status;
  end if;

  -- Voiding an existing line stays permitted: it is how a line is removed from
  -- the record without deleting it, and it leaves the priced columns intact.
  if new.record_status = 'void' and old.record_status <> 'void' then
    return new;
  end if;

  if (new.qty_milli, new.unit_cost_ten_thou, new.unit_price_ten_thou,
      new.line_cost_cents, new.line_total_cents, new.calc_mode, new.unit_label,
      new.code, new.description, new.is_taxable, new.is_optional, new.is_included,
      new.is_allowance, new.rate_item_id, new.cost_code_id, new.line_group)
     is distinct from
     (old.qty_milli, old.unit_cost_ten_thou, old.unit_price_ten_thou,
      old.line_cost_cents, old.line_total_cents, old.calc_mode, old.unit_label,
      old.code, old.description, old.is_taxable, old.is_optional, old.is_included,
      old.is_allowance, old.rate_item_id, old.cost_code_id, old.line_group)
  then
    raise exception 'line % belongs to a % quote and its priced columns are immutable',
      row_id, parent_status;
  end if;

  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists guard_quote_lines on quote_lines;
--> statement-breakpoint
create trigger guard_quote_lines before insert or update on quote_lines
  for each row execute function guard_quote_line_mutability();
--> statement-breakpoint

-- The header of a non-draft quote is whitelist-only: status, the sent, accepted
-- and declined timestamps, pdf_path, internal_notes, acceptance details, and
-- the void columns. Everything else is what the customer read.
create or replace function guard_quote_mutability() returns trigger as $$
begin
  if old.status = 'draft' then
    return new;
  end if;

  if (new.project_id, new.quote_number, new.kind, new.parent_quote_id, new.sequence,
      new.reason, new.schedule_impact_days, new.version, new.quote_date, new.valid_until,
      new.scope_template_id, new.area_sqft_milli, new.washroom_count, new.kitchen_count,
      new.bedroom_count, new.subtotal_cents, new.tax_total_cents, new.total_cents,
      new.total_cost_cents, new.margin_bp, new.holdback_pct_ten_thou, new.pricing_display,
      new.exclusions_text, new.assumptions_text, new.terms, new.notes, new.payment_terms_text)
     is distinct from
     (old.project_id, old.quote_number, old.kind, old.parent_quote_id, old.sequence,
      old.reason, old.schedule_impact_days, old.version, old.quote_date, old.valid_until,
      old.scope_template_id, old.area_sqft_milli, old.washroom_count, old.kitchen_count,
      old.bedroom_count, old.subtotal_cents, old.tax_total_cents, old.total_cents,
      old.total_cost_cents, old.margin_bp, old.holdback_pct_ten_thou, old.pricing_display,
      old.exclusions_text, old.assumptions_text, old.terms, old.notes, old.payment_terms_text)
  then
    raise exception 'quote % is % and only its status, timestamps, notes and void columns may change',
      old.id, old.status;
  end if;

  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists guard_quotes on quotes;
--> statement-breakpoint
create trigger guard_quotes before update on quotes
  for each row execute function guard_quote_mutability();
--> statement-breakpoint

-- The snapshotted tax breakdown of a non-draft quote is immutable for the same
-- reason its lines are: it is the arithmetic printed on the document.
create or replace function guard_quote_tax_mutability() returns trigger as $$
declare
  parent_status text;
  parent_id uuid := coalesce(new.quote_id, old.quote_id);
begin
  select status into parent_status from quotes where id = parent_id;
  if parent_status is null or parent_status = 'draft' then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    raise exception 'quote % is % and its tax breakdown is already fixed', parent_id, parent_status;
  end if;

  if new.record_status = 'void' and old.record_status <> 'void' then
    return new;
  end if;

  if (new.label, new.registration_number, new.rate_ten_thou,
      new.taxable_base_cents, new.tax_amount_cents)
     is distinct from
     (old.label, old.registration_number, old.rate_ten_thou,
      old.taxable_base_cents, old.tax_amount_cents)
  then
    raise exception 'the tax breakdown of a % quote is immutable', parent_status;
  end if;

  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists guard_quote_taxes on quote_taxes;
--> statement-breakpoint
create trigger guard_quote_taxes before insert or update on quote_taxes
  for each row execute function guard_quote_tax_mutability();
