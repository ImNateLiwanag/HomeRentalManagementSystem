DROP POLICY notifications_insert_actor ON public.notifications;
CREATE POLICY notifications_insert_actor ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()) AND ((SELECT app_private.is_admin()) OR tenant_id = (SELECT auth.uid())));
