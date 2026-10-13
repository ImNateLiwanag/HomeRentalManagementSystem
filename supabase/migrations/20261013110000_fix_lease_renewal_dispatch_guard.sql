CREATE OR REPLACE FUNCTION app_private.guard_lease_renewal_response()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF (NEW.tenant_id, NEW.tenancy_id, NEW.start_date, NEW.end_date, NEW.monthly_rent,
      NEW.billable_months, NEW.estimated_amount, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.tenancy_id, OLD.start_date, OLD.end_date, OLD.monthly_rent,
      OLD.billable_months, OLD.estimated_amount, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Renewal offer details cannot be changed after creation.' USING ERRCODE = '23514';
  END IF;

  -- The dispatcher runs with elevated privileges and is the only path that
  -- moves a scheduled offer to the tenant-visible Pending state.
  IF OLD.status = 'Scheduled' AND NEW.status = 'Pending' AND NEW.responded_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'Pending' OR NEW.status NOT IN ('Accepted','Declined')
     OR NEW.responded_at IS NULL THEN
    RAISE EXCEPTION 'Only a pending renewal offer can receive a tenant response.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'Accepted' THEN
    UPDATE public.tenancies SET lease_end_date = NEW.end_date WHERE id = NEW.tenancy_id AND end_date IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;
