CREATE TABLE public.admin_calendar_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  note_date date NOT NULL,
  details text CHECK (details IS NULL OR char_length(details) <= 1000),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_calendar_notes_date_idx
  ON public.admin_calendar_notes (note_date, created_at);

ALTER TABLE public.admin_calendar_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.admin_calendar_notes TO authenticated;

CREATE POLICY admin_calendar_notes_read_admin
  ON public.admin_calendar_notes FOR SELECT TO authenticated
  USING ((SELECT app_private.is_admin()));
CREATE POLICY admin_calendar_notes_insert_admin
  ON public.admin_calendar_notes FOR INSERT TO authenticated
  WITH CHECK ((SELECT app_private.is_admin()) AND created_by = (SELECT auth.uid()));
CREATE POLICY admin_calendar_notes_delete_admin
  ON public.admin_calendar_notes FOR DELETE TO authenticated
  USING ((SELECT app_private.is_admin()));
