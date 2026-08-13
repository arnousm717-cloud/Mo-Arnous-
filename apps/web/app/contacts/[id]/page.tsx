import { redirect, notFound } from "next/navigation";
import { getAuthenticatedUser, resolveOrganizationContextForUser, can } from "@ai-revenue-os/auth";
import { handleGetContact } from "../../api/v1/contacts/[id]/handlers";
import { decideContactsConsoleAccess } from "../access";
import { listActiveCompanyOptions } from "../company-options";
import { listActiveOwnerOptions } from "../../companies/owner-options";
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
 * treated as an error here — the contact's companyId is displayed as-is
 * (falling back to the raw id when its name isn't resolvable via the
 * active-only company list), never dropped or nulled by this page.
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
  const companyOptions = canUpdate || contact.companyId ? await listActiveCompanyOptions(actor) : [];
  const ownerOptions = canUpdate ? await listActiveOwnerOptions(actor) : [];
  const companyName = contact.companyId
    ? (companyOptions.find((c) => c.id === contact.companyId)?.name ?? contact.companyId)
    : null;

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
          <dd>{contact.ownerId ?? "—"}</dd>
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
