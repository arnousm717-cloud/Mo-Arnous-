import { can } from "@ai-revenue-os/auth";
import { ActivityTimeline, TagList, type TimelineEntry } from "@ai-revenue-os/ui";
import { listActiveOwnerOptions } from "../owner-options";
import { loadTimeline } from "./loader";
import { resolveCreatorLabel } from "./creator-label";
import { listAttachedTagsForResolvedContext } from "./tag-logic";
import { ActivityCreateForm, type EditableActivity } from "./activity-form";
import { NoteCreateForm, type EditableNote } from "./note-form";
import { ActivityEntryActions, NoteEntryActions } from "./entry-actions";
import { AttachExistingTagForm, CreateAndAttachTagForm, RemoveTaggingButton } from "./tag-controls";
import { DEFAULT_TIMELINE_LIMIT, TIMELINE_LIMIT_INCREMENT } from "./timeline-limit";
import type { CrmRecordType, ResolvedCrmActor } from "./types";
import styles from "../../companies/companies.module.css";

/**
 * Milestone 2.3E. The one shared entry point Company/Contact/Deal detail
 * pages embed — the frozen 2.3E decision: ONE implementation,
 * parameterized by relatedToType/relatedToId/returnPath, not three
 * near-identical copies. Owns every data-fetching/RBAC/tenant-context
 * concern; ActivityTimeline/TagList (packages/ui) never see any of it —
 * they only receive already-resolved, already-safe view models and
 * pre-decided action slots.
 *
 * Every can() check here is server-side, computed once — the UI is never
 * the authorization boundary: handleX still re-checks can() on every
 * mutation regardless of what this component chose to render (2.3D).
 */

export async function ActivityTimelineSection({
  actor,
  relatedToType,
  relatedToId,
  returnPath,
  timelineLimit = DEFAULT_TIMELINE_LIMIT,
}: {
  actor: ResolvedCrmActor;
  relatedToType: CrmRecordType;
  relatedToId: string;
  returnPath: string;
  timelineLimit?: number;
}): Promise<React.ReactElement> {
  const canReadActivities = can(actor, "activities:read");
  const canCreateActivities = can(actor, "activities:create");
  const canUpdateActivities = can(actor, "activities:update");
  const canDeleteActivities = can(actor, "activities:delete");
  const canReadNotes = can(actor, "notes:read");
  const canCreateNotes = can(actor, "notes:create");
  const canUpdateNotes = can(actor, "notes:update");
  const canDeleteNotes = can(actor, "notes:delete");
  const canReadTags = can(actor, "tags:read");
  const canCreateTags = can(actor, "tags:create");
  const canDeleteTags = can(actor, "tags:delete");

  const ownerOptions = await listActiveOwnerOptions(actor);

  let entries: TimelineEntry[] = [];
  let hasMore = false;
  let timelineState: "empty" | "error" | "ready" = "empty";

  if (canReadActivities || canReadNotes) {
    const result = await loadTimeline(actor.userId, relatedToType, relatedToId, timelineLimit, ownerOptions);
    if (result.error) {
      timelineState = "error";
    } else {
      entries = result.entries.map((entry) =>
        entry.kind === "activity"
          ? {
              ...entry,
              creatorLabel: resolveCreatorLabel(entry.creatorLabel),
              actions: (
                <ActivityEntryActions
                  activity={
                    {
                      id: entry.id,
                      type: entry.activityType ?? "task",
                      subject: entry.subject,
                      body: entry.body,
                    } satisfies EditableActivity
                  }
                  returnPath={returnPath}
                  canUpdate={canUpdateActivities}
                  canDelete={canDeleteActivities}
                />
              ),
            }
          : {
              ...entry,
              creatorLabel: resolveCreatorLabel(entry.creatorLabel),
              actions: (
                <NoteEntryActions
                  note={{ id: entry.id, body: entry.body } satisfies EditableNote}
                  returnPath={returnPath}
                  canUpdate={canUpdateNotes}
                  canDelete={canDeleteNotes}
                />
              ),
            },
      );
      hasMore = result.hasMore;
      timelineState = entries.length === 0 ? "empty" : "ready";
    }
  }

  const loadMoreHref = `${returnPath}?timelineLimit=${timelineLimit + TIMELINE_LIMIT_INCREMENT}`;

  const createControls =
    canCreateActivities || canCreateNotes ? (
      <div className={styles.section}>
        {canCreateActivities ? (
          <ActivityCreateForm relatedToType={relatedToType} relatedToId={relatedToId} returnPath={returnPath} />
        ) : null}
        {canCreateNotes ? (
          <NoteCreateForm relatedToType={relatedToType} relatedToId={relatedToId} returnPath={returnPath} />
        ) : null}
      </div>
    ) : undefined;

  let tagSection: React.ReactElement | null = null;
  if (canReadTags) {
    const tagsResult = await listAttachedTagsForResolvedContext(actor.userId, relatedToType, relatedToId);
    const tagChips = tagsResult.attached.map((tag) => ({
      id: tag.taggingId,
      tagId: tag.tagId,
      name: tag.name,
      color: tag.color,
      removeAction: canDeleteTags ? <RemoveTaggingButton taggingId={tag.taggingId} returnPath={returnPath} /> : undefined,
    }));

    const addControls = canCreateTags ? (
      <>
        <AttachExistingTagForm
          taggableType={relatedToType}
          taggableId={relatedToId}
          returnPath={returnPath}
          options={tagsResult.availableToAttach}
        />
        <CreateAndAttachTagForm taggableType={relatedToType} taggableId={relatedToId} returnPath={returnPath} />
      </>
    ) : undefined;

    tagSection = (
      <section className={styles.section}>
        <h2>Tags</h2>
        {tagsResult.error ? (
          <p role="alert" className={styles.formError}>
            {tagsResult.error}
          </p>
        ) : (
          <TagList tags={tagChips} addControls={addControls} />
        )}
      </section>
    );
  }

  return (
    <>
      {canReadActivities || canReadNotes ? (
        <section className={styles.section}>
          <h2>Activity</h2>
          <ActivityTimeline
            entries={entries}
            state={timelineState}
            hasMore={hasMore}
            loadMoreHref={loadMoreHref}
            createControls={createControls}
          />
        </section>
      ) : null}
      {tagSection}
    </>
  );
}
