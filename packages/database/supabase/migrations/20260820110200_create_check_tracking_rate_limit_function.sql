-- Milestone 3.1C-A: check_tracking_rate_limit() -- the one narrow
-- SECURITY DEFINER primitive backing every rate-limit dimension the
-- future public collect/consent endpoints will need (3.1C-C, not yet
-- built): per-anonymous-visitor, per-source-IP, and per-tracking-site
-- aggregate, for both surfaces. One function, not six -- the different
-- limits/window lengths/namespace prefixes are ordinary, trusted
-- application configuration passed as parameters, not a reason to build
-- a separate SQL object per dimension (3.1C-A design review).
--
-- window_start is computed EXCLUSIVELY from the database's own now(),
-- floored to the caller-supplied window length -- never accepted as a
-- parameter. A design that let the caller supply window_start directly
-- was evaluated and rejected during design review: it would let a
-- confused or malicious authenticated-role caller pass a fresh,
-- never-before-seen timestamp on every call, landing each request in a
-- brand-new bucket row and never accumulating a count against any prior
-- request -- completely defeating the limiter's own purpose. There is no
-- window_start parameter here at all, closing that class of bug
-- structurally, not just by convention.
--
-- Two-tier cleanup, both isolated in their own nested BEGIN/EXCEPTION
-- block (an implicit savepoint) so a cleanup failure can NEVER affect
-- the already-computed allow/reject decision -- v_count and the return
-- value are fully determined before either tier is attempted:
--   Tier 1 (per-bucket): deletes this same bucket's own stale windows,
--     served entirely by the primary key's own index -- cheap, always
--     safe, keeps any actively-used bucket to 1-2 rows.
--   Tier 2 (opportunistic global): fires on a small random fraction of
--     calls (random() < 0.001, evaluated entirely server-side -- no
--     caller input influences whether it fires, closing off any
--     caller-controlled cleanup-timing bypass), removing at most 1000
--     rows more than 24 hours stale, via the companion
--     rate_limit_counters_window_start_idx index. This closes the
--     residual "single-use bucket rows accumulate forever" gap
--     identified during design review -- per-bucket cleanup alone only
--     bounds a REUSED bucket's own row count, never a never-revisited
--     one's. 24 hours is chosen because a 60-second window's
--     decision-relevance expires the instant it closes; 24h is already
--     1,440x that, ample for operational lookback, while remaining far
--     shorter than consent_records' unrelated 7-year compliance-evidence
--     retention -- this is abuse telemetry, not compliance evidence.
--     Structurally cannot touch the current active window: window_start
--     for any live window is always within seconds of now(), and this
--     predicate only ever matches rows more than 24 hours stale --
--     PROVIDED p_window_seconds itself never exceeds 86400 (24 hours).
--
-- p_window_seconds is capped at 86400 (24 hours) for exactly this reason.
-- The final acceptance audit proved deterministically that a window
-- length beyond that bound breaks the "cannot touch the current active
-- window" property above: v_window_start (the START of the CURRENT
-- window) can be up to (p_window_seconds - 1) seconds before now() by
-- construction, so once p_window_seconds > 86400 there exists a real
-- moment -- late in every such window -- where the still-active window's
-- own row is already >24h stale by Tier 2's own predicate, making it
-- eligible for probabilistic deletion mid-window and silently resetting
-- that bucket's count. The invariant "the maximum active window must
-- never be older than the global cleanup retention horizon" is enforced
-- here, in the function itself, rather than left as an undocumented
-- caller obligation -- 86400 is therefore not an arbitrary limit, it is
-- exactly the Tier 2 retention horizon this function already commits to
-- elsewhere in this same file.

create function public.check_tracking_rate_limit(
  p_bucket_hash text,
  p_window_seconds integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_limit <= 0 then
    raise exception 'p_limit must be positive';
  end if;
  if p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be positive';
  end if;
  if p_window_seconds > 86400 then
    raise exception 'p_window_seconds must not exceed 86400 (24 hours) -- the current active window would otherwise be able to outlive the Tier 2 cleanup retention horizon';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limit_counters (bucket_hash, window_start, count)
  values (p_bucket_hash, v_window_start, 1)
  on conflict (bucket_hash, window_start)
  do update set count = rate_limit_counters.count + 1
  returning count into v_count;

  -- The rate-limit decision is now fully determined by v_count and will
  -- be returned regardless of anything below this line.

  begin
    delete from public.rate_limit_counters
    where bucket_hash = p_bucket_hash
      and window_start < v_window_start;
  exception when others then
    null;
  end;

  begin
    if random() < 0.001 then
      delete from public.rate_limit_counters
      where ctid in (
        select ctid from public.rate_limit_counters
        where window_start < now() - interval '24 hours'
        limit 1000
      );
    end if;
  exception when others then
    null;
  end;

  return v_count <= p_limit;
end;
$$;

comment on function public.check_tracking_rate_limit(text, integer, integer) is
  'Milestone 3.1C-A. Atomic fixed-window rate-limit check-and-increment for the future public tracking collect/consent endpoints -- one function serves every dimension (anonymous_id/IP/tracking-site, for both collect and consent), keyed entirely by an opaque, application-computed bucket_hash (never a raw identifier). window_start is server-computed from now() only -- no caller-supplied timestamp exists. p_window_seconds is bounded to (0, 86400] -- the upper bound is not arbitrary, it is exactly the Tier 2 cleanup retention horizon, enforced here so the currently active window can never outlive it and become eligible for deletion. Two-tier cleanup (per-bucket + opportunistic bounded global sweep of rows >24h stale) is isolated so a cleanup failure can never alter the already-determined allow/reject result. EXECUTE granted to authenticated only, mirroring resolve_tracking_site()/check_visitor_cookie_tracking_consent()''s own privilege model exactly -- PUBLIC/anon receive zero EXECUTE by construction (the M1.7-era default-privilege hardening, 20260812140000, already revokes PUBLIC execute on every function created after it).';

grant execute on function public.check_tracking_rate_limit(text, integer, integer) to authenticated;
