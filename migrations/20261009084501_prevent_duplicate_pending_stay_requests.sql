CREATE UNIQUE INDEX stay_requests_one_pending_date_range
  ON public.stay_requests (tenant_id, start_date, end_date)
  WHERE status = 'Pending';
