ALTER TABLE public.tenancies ADD COLUMN IF NOT EXISTS lease_end_date date;

CREATE TABLE IF NOT EXISTS public.lease_renewal_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenancy_id uuid NOT NULL REFERENCES public.tenancies(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  monthly_rent numeric(12,2) NOT NULL CHECK (monthly_rent > 0),
  billable_months numeric(8,1) NOT NULL,
  estimated_amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Pending','Accepted','Declined','Expired')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (end_date > start_date),
  CHECK (billable_months >= 1 AND estimated_amount > 0),
  CHECK ((status IN ('Scheduled','Pending') AND responded_at IS NULL) OR (status IN ('Accepted','Declined') AND responded_at IS NOT NULL) OR status = 'Expired')
);

CREATE UNIQUE INDEX IF NOT EXISTS lease_renewal_one_open_offer_per_tenancy
  ON public.lease_renewal_offers (tenancy_id)
  WHERE status IN ('Scheduled','Pending');
CREATE INDEX IF NOT EXISTS lease_renewal_by_tenant
  ON public.lease_renewal_offers (tenant_id, created_at DESC);

ALTER TABLE public.lease_renewal_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.lease_renewal_offers TO authenticated;

CREATE POLICY lease_renewal_select_owner_or_admin
  ON public.lease_renewal_offers FOR SELECT TO authenticated
  USING (tenant_id = (SELECT auth.uid()) OR (SELECT app_private.is_admin()));
CREATE POLICY lease_renewal_insert_admin
  ON public.lease_renewal_offers FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT app_private.is_admin()) AND created_by = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.tenancies t WHERE t.id = lease_renewal_offers.tenancy_id
      AND t.tenant_id = lease_renewal_offers.tenant_id AND t.end_date IS NULL
      AND t.lease_end_date IS NOT NULL AND lease_renewal_offers.start_date = t.lease_end_date + 1)
  );
CREATE POLICY lease_renewal_update_tenant_response
  ON public.lease_renewal_offers FOR UPDATE TO authenticated
  USING (tenant_id = (SELECT auth.uid()) AND status = 'Pending')
  WITH CHECK (tenant_id = (SELECT auth.uid()) AND status IN ('Accepted','Declined'));

CREATE OR REPLACE FUNCTION app_private.calculate_lease_renewal_estimate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  nights integer;
  half_month_blocks integer;
BEGIN
  IF NEW.end_date <= NEW.start_date THEN
    RAISE EXCEPTION 'Renewal end date must be after its start date.' USING ERRCODE = '23514';
  END IF;
  nights := NEW.end_date - NEW.start_date;
  half_month_blocks := GREATEST(2, CEIL(nights::numeric / 15)::integer);
  NEW.billable_months := half_month_blocks::numeric / 2;
  NEW.estimated_amount := ROUND(NEW.monthly_rent * NEW.billable_months, 2);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.calculate_lease_renewal_estimate() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER lease_renewal_calculate_estimate BEFORE INSERT ON public.lease_renewal_offers
  FOR EACH ROW EXECUTE FUNCTION app_private.calculate_lease_renewal_estimate();

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
REVOKE ALL ON FUNCTION app_private.guard_lease_renewal_response() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER lease_renewal_guard_response BEFORE UPDATE ON public.lease_renewal_offers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_lease_renewal_response();

CREATE OR REPLACE FUNCTION public.dispatch_due_lease_renewals()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE dispatched integer;
BEGIN
  WITH due AS (
    UPDATE public.lease_renewal_offers offer
       SET status = 'Pending'
     WHERE offer.status = 'Scheduled'
       AND (SELECT tenancy.lease_end_date FROM public.tenancies tenancy WHERE tenancy.id = offer.tenancy_id) <= CURRENT_DATE + 3
       AND offer.start_date > CURRENT_DATE
    RETURNING offer.tenant_id, offer.created_by, offer.start_date, offer.end_date, offer.monthly_rent, offer.estimated_amount
  ), inserted AS (
    INSERT INTO public.notifications (tenant_id, created_by, message)
    SELECT due.tenant_id, due.created_by,
      'Your lease renewal offer is ready: ' || due.start_date::text || ' to ' || due.end_date::text ||
      ', PHP ' || to_char(due.monthly_rent, 'FM999,999,990.00') || ' per month; estimated total PHP ' ||
      to_char(due.estimated_amount, 'FM999,999,990.00') || '. Please review it under Lease Renewals.'
    FROM due RETURNING id
  ) SELECT count(*)::integer INTO dispatched FROM inserted;

  UPDATE public.lease_renewal_offers offer SET status = 'Expired'
   WHERE offer.status IN ('Scheduled','Pending')
     AND (SELECT tenancy.lease_end_date FROM public.tenancies tenancy WHERE tenancy.id = offer.tenancy_id) < CURRENT_DATE;

  UPDATE public.tenancies tenancy SET monthly_rent = offer.monthly_rent
    FROM public.lease_renewal_offers offer
   WHERE offer.tenancy_id = tenancy.id AND offer.status = 'Accepted'
     AND offer.start_date <= CURRENT_DATE AND tenancy.end_date IS NULL
     AND tenancy.monthly_rent <> offer.monthly_rent;
  RETURN dispatched;
END;
$function$;
REVOKE ALL ON FUNCTION public.dispatch_due_lease_renewals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_due_lease_renewals() TO authenticated;
