import { redirect, notFound } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { getCompanyByIdIncludingDeleted } from "@ai-revenue-os/crm";
import { handleGetContact } from "../../api/v1/contacts/[id]/handlers";
import { decideContactsConsoleAccess } from "../access";
import { listActiveCompanyOptions } from "../company-options";
import { listActiveOwnerOptions } from "../../_shared/owner-options";
import { resolveOwnerLabel } from "../../_shared/owner-option";
import { ContactEditForm, type EditableContact } from "./contact-edit-form";
import { DeleteContactForm } from "./delete-contact-form";
import styles from "../../companies/companies.module.css";

interface ContactDetail extends EditableContact {
  createdAt: string;
  updatedAt: string;
}

/**
 * Milestone 2.1G-C. Mirrors apps/web/app/companies/[id]/page.tsx exactly.
 * handleGetContact already returns an identical 404 for a cross-org id, a
 * genuinely nonexistent one, and a soft-deleted contact — this page adds
 * no special-casing, it just maps "not 200" to notFound().
 *
 * A linked company that has since been soft-deleted is deliberately NOT
 * treated as an error here — the contact's companyId is displayed as-is,
 * never dropped or nulled by this page. Its name is resolved via
 * getCompanyByIdIncludingDeleted (tenant-scoped, read-only) when it isn't
 * in the active company list, rendered as "<name> (deleted)" — never the
 * raw id. The resolved entry is also merged into the companyOptions
 * passed to ContactEditForm so its own select shows that label instead
 * of falling back to its id-only synthetic option, without needing any
 * change to that component.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  const orgContext = user ? await resolveOrganizationContextForUser(user.id) : null;
  const decision = decideContactsConsoleAccess(user?.id ?? null, orgContext);

  if (decision.kind === "redirect") {
    redirect(decision.to);
  }

  const { userId, organizationId, roleKey } = decision.orgContext;
  const response = await handleGetContact(userId, id);
  if (response.status !== 200) {
    notFound();
  }

  const data = (await response.json()) as { contact: ContactDetail };
  const contact = data.contact;

  const actor = { userId, organizationId, roleKey };
  const canUpdate = can(actor, "contacts:update");
  const canDelete = can(actor, "contacts:delete");
  let companyOptions = canUpdate || contact.companyId ? await listActiveCompanyOptions(actor) : [];
  const ownerOptions = canUpdate || contact.ownerId ? await listActiveOwnerOptions(actor) : [];

  let companyName: string | null = null;
  if (contact.companyId) {
    const active = companyOptions.find((c) => c.id === contact.companyId);
    if (active) {
      companyName = active.name;
    } else {
      const deleted = await getCompanyByIdIncludingDeleted(actor, contact.companyId);
      if (deleted) {
        const label = `${deleted.name} (deleted)`;
        companyName = label;
        if (canUpdate) {
          companyOptions = [...companyOptions, { id: deleted.id, name: label }];
        }
      } else {
        // Unresolvable even including soft-deleted rows (e.g. genuinely
        // orphaned) — never render the raw id; ContactEditForm's own
        // existing id-only synthetic fallback still preserves the value.
        companyName = "Deleted company";
      }
    }
  }

  const displayName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "(no name)";

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>{displayName}</h1>
      </header>

      {canUpdate ? (
        <ContactEditForm contact={contact} companyOptions={companyOptions} ownerOptions={ownerOptions} />
      ) : (
        <dl className={styles.detailFields}>
          <dt>First name</dt>
          <dd>{contact.firstName ?? "—"}</dd>
          <dt>Last name</dt>
          <dd>{contact.lastName ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{contact.email ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{contact.phone ?? "—"}</dd>
          <dt>Job title</dt>
          <dd>{contact.jobTitle ?? "—"}</dd>
          <dt>LinkedIn</dt>
          <dd>{contact.linkedinUrl ?? "—"}</dd>
          <dt>Lifecycle stage</dt>
          <dd>{contact.lifecycleStage ?? "—"}</dd>
          <dt>Company</dt>
          <dd>{companyName ?? "—"}</dd>
          <dt>Owner</dt>
          <dd>{resolveOwnerLabel(ownerOptions, contact.ownerId) ?? "—"}</dd>
        </dl>
      )}

      {canDelete ? (
        <section className={styles.section}>
          <DeleteContactForm contactId={contact.id} />
        </section>
      ) : null}
    </main>
  );
}
