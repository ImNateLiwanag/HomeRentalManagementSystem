-- Add monthly billing periods, automatic tracking IDs, and private proof metadata.
ALTER TABLE public.payments
  ADD COLUMN billing_period date,
  ADD COLUMN submission_id text,
  ADD COLUMN proof_storage_path text,
  ADD COLUMN proof_file_name text,
  ADD COLUMN proof_content_type text,
  ADD COLUMN proof_file_size bigint,
  ADD COLUMN is_active_submission boolean NOT NULL DEFAULT true;

-- Backfill existing payment rows before requiring a rent period and tracking ID.
UPDATE public.payments
SET billing_period = date_trunc('month', paid_on)::date,
    submission_id = 'PAY-' || upper(substr(replace(id::text, '-', ''), 1, 16))
WHERE billing_period IS NULL OR submission_id IS NULL;

-- Keep existing rows intact while marking duplicate/rejected historical rows as inactive.
WITH ranked AS (
  SELECT id, status,
         row_number() OVER (
           PARTITION BY tenant_id, date_trunc('month', paid_on)::date
           ORDER BY (status = 'Rejected') ASC, created_at ASC, id ASC
         ) AS row_number
  FROM public.payments
)
UPDATE public.payments AS p
SET is_active_submission = (ranked.row_number = 1 AND ranked.status <> 'Rejected')
FROM ranked
WHERE ranked.id = p.id;

ALTER TABLE public.payments
  ALTER COLUMN billing_period SET NOT NULL,
  ALTER COLUMN submission_id SET NOT NULL,
  ALTER COLUMN submission_id SET DEFAULT ('PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
  ALTER COLUMN reference DROP NOT NULL;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_billing_period_month_start
    CHECK (billing_period = date_trunc('month', billing_period)::date),
  ADD CONSTRAINT payments_proof_metadata_check
    CHECK (
      (proof_storage_path IS NULL AND proof_file_name IS NULL AND proof_content_type IS NULL AND proof_file_size IS NULL)
      OR
      (proof_storage_path IS NOT NULL AND length(trim(proof_storage_path)) > 0
       AND proof_file_name IS NOT NULL AND length(trim(proof_file_name)) > 0
       AND proof_content_type IN ('application/pdf', 'image/jpeg', 'image/png')
       AND proof_file_size BETWEEN 1 AND 10485760)
    );

CREATE UNIQUE INDEX payments_submission_id_key
  ON public.payments (submission_id);

CREATE UNIQUE INDEX payments_one_active_submission_per_month
  ON public.payments (tenant_id, billing_period)
  WHERE is_active_submission;

CREATE OR REPLACE FUNCTION app_private.release_rejected_payment_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'Rejected' THEN
    NEW.is_active_submission := false;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.release_rejected_payment_period() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER payments_release_rejected_period
  BEFORE UPDATE OF status ON public.payments
  FOR EACH ROW
  WHEN (NEW.status = 'Rejected')
  EXECUTE FUNCTION app_private.release_rejected_payment_period();

DROP POLICY payments_tenant_submit ON public.payments;
CREATE POLICY payments_tenant_submit
  ON public.payments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = (SELECT auth.uid())
    AND status = 'Pending'
    AND is_active_submission IS TRUE
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND billing_period = date_trunc('month', billing_period)::date
    AND proof_storage_path LIKE ((SELECT auth.uid())::text || '/payment-proofs/%')
    AND proof_file_name IS NOT NULL
    AND proof_content_type IN ('application/pdf', 'image/jpeg', 'image/png')
    AND proof_file_size BETWEEN 1 AND 10485760
    AND amount = (
      SELECT t.monthly_rent
      FROM public.tenancies AS t
      WHERE t.tenant_id = (SELECT auth.uid())
        AND t.end_date IS NULL
      ORDER BY t.start_date DESC
      LIMIT 1
    )
  );
