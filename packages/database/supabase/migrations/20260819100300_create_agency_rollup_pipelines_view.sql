-- Milestone 2.4A: Agency roll-up read access for Pipelines.
-- Follows the exact agency_rollup_organizations pattern (20260807130200).
-- Deliberately the narrowest of the four Milestone 2.4A views — this
-- milestone's own scope decision is explicit: "expose only the fields
-- genuinely required to identify and label pipelines," never pipeline-
-- management functionality (docs/13 Milestone 2.4A "Detailed design").
--
-- Column selection:
--   included: id (join target for agency_rollup_deals.pipeline_id),
--     organization_id (attribution), name (the entire labeling purpose
--     of this view).
--   EXCLUDED: is_default is a pipeline-management/administrative concern
--     (which pipeline is the org's default for new deals), not a
--     labeling need — exposing it would edge toward the pipeline-
--     management functionality this milestone explicitly excludes from
--     the agency path. created_at/updated_at/deleted_at excluded — not
--     needed to identify or label a pipeline.
--
-- No agency_rollup_pipeline_stages view is created here, and none is
-- approved for this milestone — pipeline_stages has no permission family
-- of its own anywhere else in this codebase either (it authorizes under
-- pipelines:*), and stage-level roll-up visibility was explicitly not
-- requested. agency_rollup_deals.stage_id is correspondingly excluded
-- from that view (see its own migration's comment) rather than exposed
-- as an unresolvable raw id.

create view public.agency_rollup_pipelines
with (security_invoker = false)
as
  select
    p.id,
    p.organization_id,
    p.name
  from public.pipelines p
  join public.organizations o on o.id = p.organization_id
  where o.agency_id = current_agency()
    and current_role_key() in ('agency_owner', 'agency_admin')
    and p.deleted_at is null;

comment on view public.agency_rollup_pipelines is
  'Milestone 2.4A. Agency-scoped, read-only roll-up of active client pipelines — id/name only, deliberately minimal per this milestone''s own "identify and label, never manage" scope decision. Runs as the view owner (bypassing pipelines'' own single-org RLS policy by design) — access control is entirely the WHERE clause (current_agency() + role check), never pipelines'' base policy. No agency_rollup_pipeline_stages view exists or is in scope.';

revoke all on public.agency_rollup_pipelines from public, anon, authenticated;

grant select on public.agency_rollup_pipelines to authenticated;
