import { describe, expect, it } from "vitest";
import { projectContactProfile, projectCompanyProfile, projectDealProfile, canonicalizeProfile } from "../src/projector";
import type { Contact, Company, Deal } from "@ai-revenue-os/crm";

const BASE_CONTACT: Contact = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "org-1",
  companyId: null,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  phone: null,
  jobTitle: null,
  linkedinUrl: null,
  lifecycleStage: "lead",
  ownerId: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const BASE_COMPANY: Company = {
  id: "22222222-2222-2222-2222-222222222222",
  organizationId: "org-1",
  name: "Acme Inc",
  domain: "acme.test",
  industry: null,
  employeeCount: 50,
  annualRevenue: "1000000.00",
  linkedinUrl: null,
  enrichmentStatus: null,
  ownerId: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const BASE_DEAL: Deal = {
  id: "33333333-3333-3333-3333-333333333333",
  organizationId: "org-1",
  companyId: null,
  primaryContactId: null,
  pipelineId: "pipeline-1",
  stageId: "stage-1",
  amount: "5000.00",
  currency: "EUR",
  probability: 50,
  expectedCloseDate: "2026-06-01",
  status: "open",
  ownerId: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("projectContactProfile", () => {
  it("produces the fixed canonical shape with explicit nulls", () => {
    const profile = projectContactProfile(BASE_CONTACT, false);
    expect(profile).toEqual({
      profileVersion: 1,
      entityType: "contact",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phone: null,
      jobTitle: null,
      linkedinUrl: null,
      lifecycleStage: "lead",
      companyId: null,
      ownerId: null,
      isDeleted: false,
    });
  });

  it("never includes id/organizationId/createdAt/updatedAt", () => {
    const profile = projectContactProfile(BASE_CONTACT, false) as unknown as Record<string, unknown>;
    expect(profile.id).toBeUndefined();
    expect(profile.organizationId).toBeUndefined();
    expect(profile.createdAt).toBeUndefined();
    expect(profile.updatedAt).toBeUndefined();
  });

  it("isDeleted is exactly whatever the caller supplies, not derived from the row", () => {
    expect(projectContactProfile(BASE_CONTACT, true).isDeleted).toBe(true);
    expect(projectContactProfile(BASE_CONTACT, false).isDeleted).toBe(false);
  });
});

describe("projectCompanyProfile", () => {
  it("preserves numeric-as-string annualRevenue exactly", () => {
    const profile = projectCompanyProfile(BASE_COMPANY, false);
    expect(profile.annualRevenue).toBe("1000000.00");
    expect(typeof profile.annualRevenue).toBe("string");
  });

  it("preserves employeeCount as a plain number", () => {
    expect(projectCompanyProfile(BASE_COMPANY, false).employeeCount).toBe(50);
  });
});

describe("projectDealProfile", () => {
  it("preserves numeric-as-string amount and the source ISO date string exactly", () => {
    const profile = projectDealProfile(BASE_DEAL, false);
    expect(profile.amount).toBe("5000.00");
    expect(profile.expectedCloseDate).toBe("2026-06-01");
    expect(profile.status).toBe("open");
  });
});

describe("canonicalizeProfile", () => {
  it("is deterministic across repeated calls on the same content", () => {
    const a = canonicalizeProfile(projectContactProfile(BASE_CONTACT, false));
    const b = canonicalizeProfile(projectContactProfile(BASE_CONTACT, false));
    expect(a).toBe(b);
  });

  it("differs when content genuinely differs", () => {
    const a = canonicalizeProfile(projectContactProfile(BASE_CONTACT, false));
    const b = canonicalizeProfile(projectContactProfile({ ...BASE_CONTACT, firstName: "Grace" }, false));
    expect(a).not.toBe(b);
  });

  it("differs on isDeleted alone (tombstone vs active) with identical other fields", () => {
    const active = canonicalizeProfile(projectContactProfile(BASE_CONTACT, false));
    const tombstoned = canonicalizeProfile(projectContactProfile(BASE_CONTACT, true));
    expect(active).not.toBe(tombstoned);
  });

  it("is immune to input key reordering — the case a jsonb round-trip through Postgres actually produces", () => {
    const fixedOrder = projectContactProfile(BASE_CONTACT, false);
    // Simulates what node-postgres hands back after a jsonb round-trip:
    // the same key/value pairs, but reconstructed in a different order
    // (Postgres's jsonb storage does not preserve original key order).
    const reordered = {
      isDeleted: fixedOrder.isDeleted,
      ownerId: fixedOrder.ownerId,
      companyId: fixedOrder.companyId,
      lifecycleStage: fixedOrder.lifecycleStage,
      linkedinUrl: fixedOrder.linkedinUrl,
      jobTitle: fixedOrder.jobTitle,
      phone: fixedOrder.phone,
      email: fixedOrder.email,
      lastName: fixedOrder.lastName,
      firstName: fixedOrder.firstName,
      entityType: fixedOrder.entityType,
      profileVersion: fixedOrder.profileVersion,
    } as typeof fixedOrder;

    expect(canonicalizeProfile(reordered)).toBe(canonicalizeProfile(fixedOrder));
  });
});
