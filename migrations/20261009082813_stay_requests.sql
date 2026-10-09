CREATE TABLE public.stay_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  stay_days integer NOT NULL,
  monthly_rent numeric(12, 2) NOT NULL,
  billable_months numeric(8, 1) NOT NULL,
  estimated_amount numeric(14, 2) NOT NULL,
  status text NOT NULL DEFAULT 'Pending',
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_requests_dates_valid CHECK (end_date > start_date),
  CONSTRAINT stay_requests_estimate_valid CHECK (
    stay_days > 0 AND monthly_rent > 0 AND billable_months >= 1 AND estimated_amount > 0
  ),
  CONSTRAINT stay_requests_status_valid CHECK (status IN ('Pending', 'Approved', 'Declined')),
  CONSTRAINT stay_requests_review_state_valid CHECK (
    (status = 'Pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('Approved', 'Declined') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX stay_requests_tenant_created_idx ON public.stay_requests (tenant_id, created_at DESC);
CREATE INDEX stay_requests_pending_created_idx ON public.stay_requests (created_at DESC) WHERE status = 'Pending';
ALTER TABLE public.stay_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.stay_requests TO authenticated;
CREATE POLICY stay_requests_read_owner_or_admin ON public.stay_requests FOR SELECT TO authenticated
  USING (tenant_id = (SELECT auth.uid()) OR (SELECT app_private.is_admin()));
CREATE POLICY stay_requests_tenant_submit ON public.stay_requests FOR INSERT TO authenticated
  WITH CHECK (tenant_id = (SELECT auth.uid()) AND status = 'Pending' AND reviewed_by IS NULL AND reviewed_at IS NULL);
CREATE POLICY stay_requests_admin_review ON public.stay_requests FOR UPDATE TO authenticated
  USING ((SELECT app_private.is_admin())) WITH CHECK ((SELECT app_private.is_admin()));
