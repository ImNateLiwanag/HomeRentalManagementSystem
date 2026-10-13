create or replace function app_private.enforce_feedback_parent_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.parent_id is not null and not exists (
    select 1
    from public.feedback as parent
    where parent.id = new.parent_id
      and parent.issue_id = new.issue_id
      and parent.tenant_id = new.tenant_id
  ) then
    raise exception 'A reply must belong to the same maintenance request and tenant as its parent message.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.enforce_feedback_parent_scope() from public, anon, authenticated;

drop trigger if exists feedback_parent_scope_guard on public.feedback;
create trigger feedback_parent_scope_guard
before insert or update of parent_id, issue_id, tenant_id on public.feedback
for each row execute function app_private.enforce_feedback_parent_scope();

drop policy if exists feedback_insert_allowed on public.feedback;
create policy feedback_insert_allowed
on public.feedback
for insert to authenticated
with check (
  author_id = (select auth.uid())
  and issue_id is not null
  and exists (
    select 1
    from public.maintenance_requests as request
    where request.id = feedback.issue_id
      and request.tenant_id = feedback.tenant_id
      and (
        (select app_private.is_admin())
        or request.tenant_id = (select auth.uid())
      )
  )
);

grant delete on table public.feedback to authenticated;

drop policy if exists documents_admin_delete on public.documents;
drop policy if exists documents_delete_owner_or_admin on public.documents;
create policy documents_delete_owner_or_admin
on public.documents
for delete to authenticated
using (
  tenant_id = (select auth.uid())
  or (select app_private.is_admin())
);
