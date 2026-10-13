CREATE TABLE IF NOT EXISTS public.rent_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenancy_id uuid NOT NULL REFERENCES public.tenancies(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  current_rent numeric(10,2) NOT NULL CHECK (current_rent > 0),
  proposed_rent numeric(10,2) NOT NULL CHECK (proposed_rent > 0),
  effective_date date NOT NULL,
  terms_version text NOT NULL,
  terms_text text NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Accepted', 'Declined')),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  accepted_terms_version text,
  applied_at timestamptz,
  CHECK (proposed_rent <> current_rent),
  CHECK ((status = 'Pending' AND responded_at IS NULL) OR (status <> 'Pending' AND responded_at IS NOT NULL)),
  CHECK (status <> 'Accepted' OR accepted_terms_version = terms_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS rent_change_one_open_proposal_per_tenancy
  ON public.rent_change_proposals (tenancy_id)
  WHERE status = 'Pending' OR (status = 'Accepted' AND applied_at IS NULL);
CREATE INDEX IF NOT EXISTS rent_change_tenant_recent
  ON public.rent_change_proposals (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rent_change_effective_pending
  ON public.rent_change_proposals (effective_date)
  WHERE status = 'Accepted' AND applied_at IS NULL;

ALTER TABLE public.rent_change_proposals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.rent_change_proposals TO authenticated;

CREATE POLICY rent_change_select_owner_or_admin
  ON public.rent_change_proposals FOR SELECT TO authenticated
  USING (tenant_id = (SELECT auth.uid()) OR (SELECT app_private.is_admin()));

CREATE POLICY rent_change_insert_admin
  ON public.rent_change_proposals FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT app_private.is_admin())
    AND created_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.tenancies AS tenancy
      WHERE tenancy.id = rent_change_proposals.tenancy_id
        AND tenancy.tenant_id = rent_change_proposals.tenant_id
        AND tenancy.unit_id = rent_change_proposals.unit_id
        AND tenancy.end_date IS NULL
        AND tenancy.monthly_rent = rent_change_proposals.current_rent
    )
  );

CREATE POLICY rent_change_update_owner_pending
  ON public.rent_change_proposals FOR UPDATE TO authenticated
  USING (tenant_id = (SELECT auth.uid()) AND status = 'Pending')
  WITH CHECK (tenant_id = (SELECT auth.uid()) AND status IN ('Accepted', 'Declined'));

CREATE OR REPLACE FUNCTION app_private.guard_rent_change_response()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'Accepted' AND OLD.applied_at IS NULL
     AND NEW.status = OLD.status
     AND NEW.applied_at IS NOT NULL
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.tenancy_id IS NOT DISTINCT FROM OLD.tenancy_id
     AND NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id
     AND NEW.current_rent IS NOT DISTINCT FROM OLD.current_rent
     AND NEW.proposed_rent IS NOT DISTINCT FROM OLD.proposed_rent
     AND NEW.effective_date IS NOT DISTINCT FROM OLD.effective_date
     AND NEW.terms_version IS NOT DISTINCT FROM OLD.terms_version
     AND NEW.terms_text IS NOT DISTINCT FROM OLD.terms_text
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.responded_at IS NOT DISTINCT FROM OLD.responded_at
     AND NEW.accepted_terms_version IS NOT DISTINCT FROM OLD.accepted_terms_version THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'Pending'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.tenancy_id IS DISTINCT FROM OLD.tenancy_id
     OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.current_rent IS DISTINCT FROM OLD.current_rent
     OR NEW.proposed_rent IS DISTINCT FROM OLD.proposed_rent
     OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
     OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
     OR NEW.terms_text IS DISTINCT FROM OLD.terms_text
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
     OR NEW.status NOT IN ('Accepted', 'Declined') THEN
    RAISE EXCEPTION 'A rent proposal can only be accepted or declined once by its tenant.'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.responded_at := now();
  IF NEW.status = 'Accepted' THEN
    NEW.accepted_terms_version := OLD.terms_version;
  ELSE
    NEW.accepted_terms_version := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_rent_change_response() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS rent_change_guard_response ON public.rent_change_proposals;
CREATE TRIGGER rent_change_guard_response
  BEFORE UPDATE ON public.rent_change_proposals
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_rent_change_response();

-- Apply accepted changes on or after their agreed effective date. This function
-- is safe for authenticated callers: it only applies previously accepted offers
-- whose effective dates have arrived, and the work is atomic with its audit marker.
CREATE OR REPLACE FUNCTION public.apply_due_rent_changes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed_count integer := 0;
BEGIN
  WITH due AS (
    UPDATE public.rent_change_proposals AS proposal
       SET applied_at = now()
     WHERE proposal.status = 'Accepted'
       AND proposal.applied_at IS NULL
       AND proposal.effective_date <= CURRENT_DATE
       AND EXISTS (
         SELECT 1 FROM public.tenancies AS tenancy
         WHERE tenancy.id = proposal.tenancy_id
           AND tenancy.tenant_id = proposal.tenant_id
           AND tenancy.unit_id = proposal.unit_id
           AND tenancy.end_date IS NULL
       )
     RETURNING proposal.id, proposal.tenancy_id, proposal.unit_id,
               proposal.tenant_id, proposal.proposed_rent
  ), updated_units AS (
    UPDATE public.units AS unit
       SET monthly_rent = due.proposed_rent
      FROM due
     WHERE unit.id = due.unit_id
    RETURNING unit.id
  ), updated_tenancies AS (
    UPDATE public.tenancies AS tenancy
       SET monthly_rent = due.proposed_rent
      FROM due
     WHERE tenancy.id = due.tenancy_id
       AND tenancy.tenant_id = due.tenant_id
       AND tenancy.unit_id = due.unit_id
       AND tenancy.end_date IS NULL
    RETURNING tenancy.id
  )
  SELECT count(*)::integer INTO changed_count FROM updated_tenancies;
  RETURN changed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_due_rent_changes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_due_rent_changes() TO authenticated;

-- Preserve the fixed room inventory and occupied-room safeguard. An occupied
-- room's catalog rate may change only as part of an accepted, due proposal.
CREATE OR REPLACE FUNCTION app_private.guard_fixed_room_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'The room inventory is fixed; new rooms cannot be added.'
      USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The room inventory is fixed; rooms cannot be deleted.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'Fixed room names cannot be changed.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Fixed rooms cannot be deactivated.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.monthly_rent IS DISTINCT FROM OLD.monthly_rent
     AND EXISTS (
       SELECT 1 FROM public.tenancies AS tenancy
       WHERE tenancy.unit_id = OLD.id AND tenancy.end_date IS NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.rent_change_proposals AS proposal
       WHERE proposal.unit_id = OLD.id
         AND proposal.status = 'Accepted'
         AND proposal.proposed_rent = NEW.monthly_rent
         AND proposal.effective_date <= CURRENT_DATE
     ) THEN
    RAISE EXCEPTION 'An occupied room rate changes only after its tenant accepts a due rent proposal.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_fixed_room_inventory() FROM PUBLIC, anon, authenticated;
