ALTER TABLE public.stay_requests
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.stay_requests DROP CONSTRAINT IF EXISTS stay_requests_status_valid;
ALTER TABLE public.stay_requests ADD CONSTRAINT stay_requests_status_valid
  CHECK (status IN ('Pending', 'Approved', 'Declined', 'Completed'));

ALTER TABLE public.stay_requests DROP CONSTRAINT IF EXISTS stay_requests_review_state_valid;
ALTER TABLE public.stay_requests ADD CONSTRAINT stay_requests_review_state_valid CHECK (
  (status = 'Pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
  OR (status IN ('Approved', 'Declined', 'Completed') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
);
ALTER TABLE public.stay_requests ADD CONSTRAINT stay_requests_completion_state_valid CHECK (
  (status = 'Completed' AND completed_at IS NOT NULL)
  OR (status <> 'Completed' AND completed_at IS NULL)
);
ALTER TABLE public.stay_requests ADD CONSTRAINT stay_requests_archive_state_valid CHECK (
  archived_at IS NULL OR status IN ('Completed', 'Declined')
);

CREATE OR REPLACE FUNCTION app_private.guard_stay_request_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status = 'Pending' AND NEW.status IN ('Pending', 'Approved', 'Declined') THEN
    IF NEW.status IN ('Approved', 'Declined')
       AND (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL) THEN
      RAISE EXCEPTION 'A reviewed stay plan must record who reviewed it and when.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'Approved' AND NEW.status = 'Completed' THEN
    IF NEW.end_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
      RAISE EXCEPTION 'A stay plan can only be completed on or after its checkout date.' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS NULL
       OR (NEW.tenant_id, NEW.start_date, NEW.end_date, NEW.stay_days, NEW.monthly_rent,
           NEW.billable_months, NEW.estimated_amount, NEW.reviewed_by, NEW.reviewed_at)
          IS DISTINCT FROM
          (OLD.tenant_id, OLD.start_date, OLD.end_date, OLD.stay_days, OLD.monthly_rent,
           OLD.billable_months, OLD.estimated_amount, OLD.reviewed_by, OLD.reviewed_at) THEN
      RAISE EXCEPTION 'Completion may only record the completion time for an approved stay plan.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('Completed', 'Declined') AND NEW.status = OLD.status THEN
    IF NOT (SELECT app_private.is_admin())
       OR (NEW.tenant_id, NEW.start_date, NEW.end_date, NEW.stay_days, NEW.monthly_rent,
           NEW.billable_months, NEW.estimated_amount, NEW.reviewed_by, NEW.reviewed_at,
           NEW.completed_at, NEW.created_at)
          IS DISTINCT FROM
          (OLD.tenant_id, OLD.start_date, OLD.end_date, OLD.stay_days, OLD.monthly_rent,
           OLD.billable_months, OLD.estimated_amount, OLD.reviewed_by, OLD.reviewed_at,
           OLD.completed_at, OLD.created_at) THEN
      RAISE EXCEPTION 'Only an administrator may archive or restore a closed stay plan.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'This stay plan can no longer be changed.' USING ERRCODE = '23514';
END;
$function$;
