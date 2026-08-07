-- Keeps public.users in sync with auth.users (docs/03-Database-Architecture.md §2.1).
--
-- Supabase Auth (GoTrue) creates auth.users rows directly via its own
-- service, not through our application code — a real signup is genuinely
-- two steps: GoTrue creates the auth identity, then this trigger creates
-- the corresponding public.users profile row, atomically, as part of the
-- same transaction GoTrue's own INSERT runs in. This is why "atomic signup"
-- in M1.3 means two guaranteed-atomic steps in sequence (this trigger, then
-- the SECURITY DEFINER function in the next migration), not one transaction
-- spanning an external HTTP service call to GoTrue.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Fires after every auth.users insert (i.e. every signup) to create the matching public.users profile row. SECURITY DEFINER because it must bypass the users_insert_own RLS policy — there is no authenticated session yet at the moment this fires.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();
