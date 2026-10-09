CREATE OR REPLACE FUNCTION app_private.calculate_stay_request_estimate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  active_rent numeric(12, 2);
  nights integer;
  half_month_blocks integer;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM (SELECT auth.uid())
     AND NOT (SELECT app_private.is_admin()) THEN
    RAISE EXCEPTION 'A stay plan can only be submitted for the signed-in tenant.' USING ERRCODE = '42501';
  END IF;
  IF NEW.start_date < CURRENT_DATE AND NOT (SELECT app_private.is_admin()) THEN
    RAISE EXCEPTION 'The planned arrival date must be today or later.' USING ERRCODE = '23514';
  END IF;
  IF NEW.end_date <= NEW.start_date THEN
    RAISE EXCEPTION 'Departure must be after arrival.' USING ERRCODE = '23514';
  END IF;

  SELECT t.monthly_rent INTO active_rent
  FROM public.tenancies AS t
  WHERE t.tenant_id = NEW.tenant_id AND t.end_date IS NULL
  ORDER BY t.start_date DESC LIMIT 1;
  IF active_rent IS NULL OR active_rent <= 0 THEN
    RAISE EXCEPTION 'An active tenancy is required to estimate a stay.' USING ERRCODE = '23514';
  END IF;

  nights := NEW.end_date - NEW.start_date;
  half_month_blocks := GREATEST(2, CEIL(nights::numeric / 15)::integer);
  NEW.stay_days := nights;
  NEW.monthly_rent := active_rent;
  NEW.billable_months := half_month_blocks::numeric / 2;
  NEW.estimated_amount := ROUND(active_rent * NEW.billable_months, 2);
  NEW.status := 'Pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.calculate_stay_request_estimate() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER stay_request_calculate_estimate BEFORE INSERT ON public.stay_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.calculate_stay_request_estimate();
CREATE TRIGGER stay_request_recalculate_estimate BEFORE UPDATE OF tenant_id, start_date, end_date ON public.stay_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.calculate_stay_request_estimate();

CREATE OR REPLACE FUNCTION app_private.guard_stay_request_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status <> 'Pending' AND
     (NEW.status, NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM
     (OLD.status, OLD.reviewed_by, OLD.reviewed_at) THEN
    RAISE EXCEPTION 'A reviewed stay plan cannot be reviewed again.' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Pending' AND NEW.status NOT IN ('Pending', 'Approved', 'Declined') THEN
    RAISE EXCEPTION 'Invalid stay plan review status.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.guard_stay_request_review() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER stay_request_review_guard BEFORE UPDATE ON public.stay_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_stay_request_review();
