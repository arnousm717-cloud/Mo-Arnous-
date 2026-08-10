-- Fixes a real cascade-blocking bug found during M1.6 planning, not a
-- theoretical one: memberships.invited_by (M1.2) was created with no
-- ON DELETE clause at all, which defaults to NO ACTION. Deleting a
-- public.users row that some OTHER membership's invited_by still points at
-- (i.e., this person invited a colleague, who is still a member) would
-- fail with a foreign-key violation — exactly the kind of subtle cascade
-- bug the M1.6 TDR (docs/13-Technical-Design-Review.md, row 3) warned
-- about, now caught before the erasure function that depends on it exists.
--
-- ON DELETE SET NULL, not CASCADE: invited_by is provenance ("who invited
-- this member"), not an ownership relationship — losing the inviter's
-- account must not delete the invitee's own still-active membership.

alter table public.memberships drop constraint memberships_invited_by_fkey;

alter table public.memberships
  add constraint memberships_invited_by_fkey
  foreign key (invited_by) references public.users (id) on delete set null;
