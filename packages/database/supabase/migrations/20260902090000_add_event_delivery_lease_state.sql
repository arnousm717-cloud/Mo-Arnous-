-- Milestone 3.3 Claim-Lease Reliability Remediation. Companion to
-- packages/database/src/events.ts's own redesign -- see that module's
-- header comment for the full rationale. Additive only: does not edit
-- event_deliveries' original M1.7 migration (20260811090000).
--
-- The Milestone 3.3 Second Final Implementation Acceptance Audit found a
-- real, reproduced defect in the prior "claim-first" design: a row's mere
-- EXISTENCE in event_deliveries meant "delivered" -- but the row was
-- inserted BEFORE consumer.handle() ran, not after it succeeded, so a
-- process crash (a Vercel function timeout/kill, an OOM, a deploy
-- rollover) between the insert and either delivery completing or its own
-- failure cleanup left a row that looked identical to a genuine success:
-- permanently un-retried, with no automated recovery.
--
-- This migration adds the two columns needed to distinguish "currently
-- being attempted, possibly by a process that has since died" from
-- "definitively, terminally delivered":
--
--   status: 'leased' (an attempt is/was in flight) or 'delivered'
--     (terminal -- once set, never changes again, and the acquisition
--     query below can never match it, so it can never be reclaimed).
--
--   lease_expires_at: a server-computed expiry set at acquisition/
--     reclamation time, never a caller-supplied value. A 'leased' row
--     whose lease_expires_at has passed is eligible for exactly one
--     future dispatch tick to atomically reclaim it and retry -- this is
--     the crash-recovery path, requiring no separate sweeper process.
--
-- Backfill: existing rows (from before this migration) are exactly the
-- OLD design's own "delivered" rows -- under the old semantics, a row's
-- existence alone meant success, since it was only ever inserted after a
-- successful attempt reached the (now-removed) old finalization step, or
-- (in the design this replaces) before an attempt whose failure path
-- always deleted it again. Either way, any row still present at the time
-- this migration runs represents a genuinely successful, already-settled
-- delivery -- so the column DEFAULT here is 'delivered', backfilling
-- every existing row to the terminal state and deliberately NOT the value
-- new leases start at. The application itself never relies on this
-- default for a fresh acquisition -- packages/database/src/events.ts
-- always specifies status = 'leased' explicitly on insert -- so this
-- default's only real job is this one-time backfill.
alter table public.event_deliveries
  add column status text not null default 'delivered' check (status in ('leased', 'delivered')),
  add column lease_expires_at timestamptz not null default now();

comment on column public.event_deliveries.status is
  'Milestone 3.3 Claim-Lease Remediation. ''leased'' = an attempt is or was in flight (possibly by a since-crashed process); ''delivered'' = terminal, permanent success -- once set, the acquire/reclaim query in packages/database/src/events.ts can never match this row again, so a delivered pair can never be redelivered.';

comment on column public.event_deliveries.lease_expires_at is
  'Milestone 3.3 Claim-Lease Remediation. Server-computed expiry for a ''leased'' row, set only by packages/database/src/events.ts''s own fixed LEASE_DURATION_SECONDS constant -- never a caller-supplied value. Meaningless once status=''delivered''. A ''leased'' row past this timestamp is eligible for exactly one future dispatch tick to atomically reclaim.';
