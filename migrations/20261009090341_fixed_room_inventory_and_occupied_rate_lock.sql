-- Establish the fixed 40-room inventory and standardize the catalog rate.
-- Existing tenancy.monthly_rent values are contract snapshots and are intentionally preserved.
INSERT INTO public.units (name, monthly_rent, is_active)
SELECT 'Room ' || room_number, 5000, true
FROM generate_series(1, 40) AS rooms(room_number)
ON CONFLICT (name) DO UPDATE
SET monthly_rent = EXCLUDED.monthly_rent,
    is_active = true;

-- Keep the catalog fixed and prevent a room's catalog rate from changing while occupied.
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
       SELECT 1
       FROM public.tenancies AS tenancy
       WHERE tenancy.unit_id = OLD.id
         AND tenancy.end_date IS NULL
     ) THEN
    RAISE EXCEPTION 'A room rate cannot be changed while the room has an active tenant.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_fixed_room_inventory() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS units_guard_fixed_inventory ON public.units;
CREATE TRIGGER units_guard_fixed_inventory
BEFORE INSERT OR UPDATE OR DELETE ON public.units
FOR EACH ROW
EXECUTE FUNCTION app_private.guard_fixed_room_inventory();
