DROP POLICY notification_reads_insert_self ON public.notification_reads;
CREATE POLICY notification_reads_insert_self ON public.notification_reads FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.notifications AS notification WHERE notification.id = notification_id)
  );
DROP POLICY audit_insert_self_or_admin ON public.audit_logs;
CREATE POLICY audit_insert_admin ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK ((SELECT app_private.is_admin()));
