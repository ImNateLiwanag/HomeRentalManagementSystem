DROP POLICY rental_docs_update_owner_or_admin ON storage.objects;
CREATE POLICY rental_docs_update_admin ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'rental-documents' AND (SELECT app_private.is_admin()))
  WITH CHECK (bucket_id = 'rental-documents' AND (SELECT app_private.is_admin()));
DROP POLICY rental_docs_delete_owner_or_admin ON storage.objects;
CREATE POLICY rental_docs_delete_owner_or_admin ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'rental-documents'
    AND (
      (SELECT app_private.is_admin())
      OR (
        (storage.foldername(name))[1] = (SELECT auth.uid())::text
        AND COALESCE((storage.foldername(name))[2], '') <> 'payment-proofs'
      )
    )
  );
