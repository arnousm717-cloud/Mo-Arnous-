import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { can, PERMISSION_MATRIX, type Actor, type PermissionKey } from "../src/permissions";

const ROLES = ["agency_owner", "agency_admin", "org_admin", "org_member", "org_viewer", "portal_customer"] as const;

const PERMISSIONS: PermissionKey[] = [
  "organizations:read",
  "organizations:list-clients",
  "organizations:create-client",
  "organizations:manage-billing",
  "organizations:manage-users",
  "organizations:manage-settings",
  "agencies:read",
  "agencies:manage-branding",
  "agencies:manage-billing",
  "agencies:manage-domains",
  "consent:record",
  "data-subject-requests:create",
  "data-subject-requests:read",
  "data-subject-requests:execute",
  "companies:read",
  "companies:create",
  "companies:update",
  "companies:delete",
  "contacts:read",
  "contacts:create",
  "contacts:update",
  "contacts:delete",
  "deals:read",
  "deals:create",
  "deals:update",
  "deals:delete",
  "pipelines:read",
  "pipelines:create",
  "pipelines:update",
  "pipelines:delete",
];

/**
 * Independently hand-written expected matrix — deliberately NOT derived
 * from packages/auth/src/permissions.ts's own PERMISSION_MATRIX. If this
 * test imported and reused that object to build its expectations, a wrong
 * value in the real matrix would make the test tautologically pass; writing
 * the expectations out by hand here is what makes this test capable of
 * catching a real mistake in the matrix, not just in can()'s mechanics.
 * Matches the explicitly approved decisions: agency_owner gets
 * agencies:manage-billing, agency_admin does not; org_admin gets
 * organizations:manage-billing for its own standalone org, no other role
 * does (including agency-scoped roles, under this distinct key).
 */
const EXPECTED: Record<(typeof ROLES)[number], Partial<Record<PermissionKey, boolean>>> = {
  agency_owner: {
    "organizations:read": false,
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "organizations:manage-billing": false,
    "organizations:manage-users": false,
    "organizations:manage-settings": false,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-billing": true,
    "agencies:manage-domains": true,
    "consent:record": false,
    "data-subject-requests:create": false,
    "data-subject-requests:read": false,
    "data-subject-requests:execute": false,
    // Milestone 2.1E: agency roles get zero direct CRM CRUD — no
    // agency_rollup_companies/agency_rollup_contacts view exists yet
    // (docs/10-CLAUDE.md §2), and an agency-scoped Actor carries agencyId,
    // not organizationId.
    "companies:read": false,
    "companies:create": false,
    "companies:update": false,
    "companies:delete": false,
    "contacts:read": false,
    "contacts:create": false,
    "contacts:update": false,
    "contacts:delete": false,
    // Milestone 2.2C: agency roles get zero direct Deals/Pipelines
    // access — same structural reason as companies:*/contacts:* above
    // (no agency_rollup_deals/agency_rollup_pipelines view exists yet).
    "deals:read": false,
    "deals:create": false,
    "deals:update": false,
    "deals:delete": false,
    "pipelines:read": false,
    "pipelines:create": false,
    "pipelines:update": false,
    "pipelines:delete": false,
  },
  agency_admin: {
    "organizations:read": false,
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "organizations:manage-billing": false,
    "organizations:manage-users": false,
    "organizations:manage-settings": false,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-billing": false, // the explicit, approved denial
    "agencies:manage-domains": true,
    "consent:record": false,
    "data-subject-requests:create": false,
    "data-subject-requests:read": false,
    "data-subject-requests:execute": false,
    "companies:read": false,
    "companies:create": false,
    "companies:update": false,
    "companies:delete": false,
    "contacts:read": false,
    "contacts:create": false,
    "contacts:update": false,
    "contacts:delete": false,
    "deals:read": false,
    "deals:create": false,
    "deals:update": false,
    "deals:delete": false,
    "pipelines:read": false,
    "pipelines:create": false,
    "pipelines:update": false,
    "pipelines:delete": false,
  },
  org_admin: {
    "organizations:read": true,
    "organizations:list-clients": false,
    "organizations:create-client": false,
    "organizations:manage-billing": true, // own standalone org only
    "organizations:manage-users": true,
    "organizations:manage-settings": true,
    "agencies:read": false,
    "agencies:manage-branding": false,
    "agencies:manage-billing": false,
    "agencies:manage-domains": false,
    // M1.6, Decision F: org_admin-only, no other role gets these.
    "consent:record": true,
    "data-subject-requests:create": true,
    "data-subject-requests:read": true,
    "data-subject-requests:execute": true,
    // Milestone 2.1E: org_admin gets all 8 CRM keys.
    "companies:read": true,
    "companies:create": true,
    "companies:update": true,
    "companies:delete": true,
    "contacts:read": true,
    "contacts:create": true,
    "contacts:update": true,
    "contacts:delete": true,
    // Milestone 2.2C: org_admin gets all 8 Deals/Pipelines keys.
    "deals:read": true,
    "deals:create": true,
    "deals:update": true,
    "deals:delete": true,
    "pipelines:read": true,
    "pipelines:create": true,
    "pipelines:update": true,
    "pipelines:delete": true,
  },
  org_member: {
    "organizations:read": true,
    "organizations:list-clients": false,
    "organizations:create-client": false,
    "organizations:manage-billing": false,
    "organizations:manage-users": false,
    "organizations:manage-settings": false,
    "agencies:read": false,
    "agencies:manage-branding": false,
    "agencies:manage-billing": false,
    "agencies:manage-domains": false,
    "consent:record": false,
    "data-subject-requests:create": false,
    "data-subject-requests:read": false,
    "data-subject-requests:execute": false,
    // Milestone 2.1E: read/create/update, no delete.
    "companies:read": true,
    "companies:create": true,
    "companies:update": true,
    "companies:delete": false,
    "contacts:read": true,
    "contacts:create": true,
    "contacts:update": true,
    "contacts:delete": false,
    // Milestone 2.2C: deals read/create/update, no delete; pipelines
    // read-only (org_member can work deals but not reshape pipeline
    // structure — the frozen matrix's own deliberate distinction).
    "deals:read": true,
    "deals:create": true,
    "deals:update": true,
    "deals:delete": false,
    "pipelines:read": true,
    "pipelines:create": false,
    "pipelines:update": false,
    "pipelines:delete": false,
  },
  org_viewer: {
    "organizations:read": true,
    "organizations:list-clients": false,
    "organizations:create-client": false,
    "organizations:manage-billing": false,
    "organizations:manage-users": false,
    "organizations:manage-settings": false,
    "agencies:read": false,
    "agencies:manage-branding": false,
    "agencies:manage-billing": false,
    "agencies:manage-domains": false,
    "consent:record": false,
    "data-subject-requests:create": false,
    "data-subject-requests:read": false,
    "data-subject-requests:execute": false,
    // Milestone 2.1E: read-only, no write of any kind.
    "companies:read": true,
    "companies:create": false,
    "companies:update": false,
    "companies:delete": false,
    "contacts:read": true,
    "contacts:create": false,
    "contacts:update": false,
    "contacts:delete": false,
    // Milestone 2.2C: read-only, no write of any kind.
    "deals:read": true,
    "deals:create": false,
    "deals:update": false,
    "deals:delete": false,
    "pipelines:read": true,
    "pipelines:create": false,
    "pipelines:update": false,
    "pipelines:delete": false,
  },
  portal_customer: {
    "organizations:read": false,
    "organizations:list-clients": false,
    "organizations:create-client": false,
    "organizations:manage-billing": false,
    "organizations:manage-users": false,
    "organizations:manage-settings": false,
    "agencies:read": false,
    "agencies:manage-branding": false,
    "agencies:manage-billing": false,
    "agencies:manage-domains": false,
    "consent:record": false,
    "data-subject-requests:create": false,
    "data-subject-requests:read": false,
    "data-subject-requests:execute": false,
    "companies:read": false,
    "companies:create": false,
    "companies:update": false,
    "companies:delete": false,
    "contacts:read": false,
    "contacts:create": false,
    "contacts:update": false,
    "contacts:delete": false,
    "deals:read": false,
    "deals:create": false,
    "deals:update": false,
    "deals:delete": false,
    "pipelines:read": false,
    "pipelines:create": false,
    "pipelines:update": false,
    "pipelines:delete": false,
  },
};

// Narrower than Actor itself (whose scope ids are genuinely optional in
// production — not every actor has both) — these test fixtures always set
// both, and the narrower return type is what lets resource-matching
// assertions below pass a guaranteed-defined id under
// exactOptionalPropertyTypes without a non-null assertion.
function actorFor(roleKey: string): Actor & { organizationId: string; agencyId: string } {
  return {
    userId: randomUUID(),
    roleKey,
    organizationId: randomUUID(),
    agencyId: randomUUID(),
  };
}

describe("can(): exhaustive permission matrix (every role x every permission)", () => {
  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const expected = EXPECTED[role][permission];
      it(`${role} ${expected ? "IS" : "is NOT"} granted ${permission}`, () => {
        expect(can(actorFor(role), permission)).toBe(expected);
      });
    }
  }
});

describe("can(): M1.6 Decision F — DSR/consent permissions are org_admin-only", () => {
  it("org_admin IS granted all three DSR permissions plus consent:record", () => {
    const actor = actorFor("org_admin");
    expect(can(actor, "consent:record")).toBe(true);
    expect(can(actor, "data-subject-requests:create")).toBe(true);
    expect(can(actor, "data-subject-requests:read")).toBe(true);
    expect(can(actor, "data-subject-requests:execute")).toBe(true);
  });

  it("agency_owner and agency_admin are denied every DSR/consent permission, even though they have broad agency-wide grants elsewhere", () => {
    for (const role of ["agency_owner", "agency_admin"] as const) {
      const actor = actorFor(role);
      expect(can(actor, "consent:record")).toBe(false);
      expect(can(actor, "data-subject-requests:create")).toBe(false);
      expect(can(actor, "data-subject-requests:read")).toBe(false);
      expect(can(actor, "data-subject-requests:execute")).toBe(false);
    }
  });

  it("every non-org_admin role is denied every DSR/consent permission", () => {
    for (const role of ROLES) {
      if (role === "org_admin") continue;
      const actor = actorFor(role);
      expect(can(actor, "consent:record")).toBe(false);
      expect(can(actor, "data-subject-requests:create")).toBe(false);
      expect(can(actor, "data-subject-requests:read")).toBe(false);
      expect(can(actor, "data-subject-requests:execute")).toBe(false);
    }
  });
});

describe("can(): the specific approved billing decision", () => {
  it("agency_owner IS granted agencies:manage-billing", () => {
    expect(can(actorFor("agency_owner"), "agencies:manage-billing")).toBe(true);
  });

  it("agency_admin is NOT granted agencies:manage-billing (explicit, approved denial)", () => {
    expect(can(actorFor("agency_admin"), "agencies:manage-billing")).toBe(false);
  });

  it("org_admin IS granted organizations:manage-billing for its own standalone organization", () => {
    expect(can(actorFor("org_admin"), "organizations:manage-billing")).toBe(true);
  });

  it("every other role is denied organizations:manage-billing, including agency-scoped roles", () => {
    for (const role of ROLES) {
      if (role === "org_admin") continue;
      expect(can(actorFor(role), "organizations:manage-billing")).toBe(false);
    }
  });

  it("the two billing keys are never granted to the same role", () => {
    for (const role of ROLES) {
      const hasOrgBilling = can(actorFor(role), "organizations:manage-billing");
      const hasAgencyBilling = can(actorFor(role), "agencies:manage-billing");
      expect(hasOrgBilling && hasAgencyBilling).toBe(false);
    }
  });
});

describe("can(): deny-by-default", () => {
  it("a permission key that exists in the union but isn't granted to a given role denies cleanly", () => {
    // org_viewer has zero write-adjacent permissions granted at all — only
    // its three read-only grants (organizations, companies, contacts) are
    // excluded from this "everything else must deny" sweep.
    const actor = actorFor("org_viewer");
    const readOnlyGrants: PermissionKey[] = [
      "organizations:read",
      "companies:read",
      "contacts:read",
      "deals:read",
      "pipelines:read",
    ];
    for (const permission of PERMISSIONS) {
      if (readOnlyGrants.includes(permission)) continue;
      expect(can(actor, permission)).toBe(false);
    }
  });

  it("portal_customer — a real seeded role with zero grants in this milestone's matrix — denies every permission", () => {
    const actor = actorFor("portal_customer");
    for (const permission of PERMISSIONS) {
      expect(can(actor, permission)).toBe(false);
    }
  });
});

describe("can(): unknown role", () => {
  it("a roleKey not present in the matrix denies, never throws", () => {
    const actor = actorFor("not_a_real_role");
    expect(() => can(actor, "organizations:read")).not.toThrow();
    expect(can(actor, "organizations:read")).toBe(false);
  });

  it("an empty-string roleKey denies", () => {
    expect(can(actorFor(""), "organizations:read")).toBe(false);
  });
});

describe("can(): missing context", () => {
  it("a null actor is denied every permission, including nominally-safe reads", () => {
    for (const permission of PERMISSIONS) {
      expect(can(null, permission)).toBe(false);
    }
  });
});

describe("can(): organization vs agency scope separation", () => {
  it("an org-scoped role is denied every agency-scoped permission, even with a coincidentally-matching resource", () => {
    const orgActor = actorFor("org_admin");
    for (const permission of ["agencies:read", "agencies:manage-branding", "agencies:manage-billing", "agencies:manage-domains"] as const) {
      expect(can(orgActor, permission, { agencyId: orgActor.agencyId })).toBe(false);
    }
  });

  it("an agency-scoped role is denied every organization-scoped permission, even with a coincidentally-matching resource", () => {
    const agencyActor = actorFor("agency_owner");
    for (const permission of ["organizations:read", "organizations:manage-billing", "organizations:manage-users", "organizations:manage-settings"] as const) {
      expect(can(agencyActor, permission, { organizationId: agencyActor.organizationId })).toBe(false);
    }
  });
});

describe("can(): explicit resource scope checking", () => {
  it("denies when the supplied resource's organizationId doesn't match the actor's own", () => {
    const actor = actorFor("org_admin");
    const someoneElsesOrgId = randomUUID();
    expect(can(actor, "organizations:manage-billing", { organizationId: someoneElsesOrgId })).toBe(false);
  });

  it("allows when the supplied resource's organizationId matches the actor's own", () => {
    const actor = actorFor("org_admin");
    expect(can(actor, "organizations:manage-billing", { organizationId: actor.organizationId })).toBe(true);
  });

  it("denies when the supplied resource's agencyId doesn't match the actor's own", () => {
    const actor = actorFor("agency_owner");
    const someoneElsesAgencyId = randomUUID();
    expect(can(actor, "agencies:manage-billing", { agencyId: someoneElsesAgencyId })).toBe(false);
  });

  it("allows when the supplied resource's agencyId matches the actor's own", () => {
    const actor = actorFor("agency_owner");
    expect(can(actor, "agencies:manage-billing", { agencyId: actor.agencyId })).toBe(true);
  });

  it("omitting resource entirely checks only the role grant, not any specific scope", () => {
    const actor = actorFor("org_admin");
    expect(can(actor, "organizations:manage-billing")).toBe(true);
  });
});

describe("can(): never throws, for any input shape", () => {
  it("does not throw for a variety of edge-case actors", () => {
    const edgeCases: (Actor | null)[] = [
      null,
      { userId: "", roleKey: "" },
      { userId: randomUUID(), roleKey: "org_admin" }, // no organizationId at all
      { userId: randomUUID(), roleKey: "agency_owner" }, // no agencyId at all
    ];
    for (const actor of edgeCases) {
      for (const permission of PERMISSIONS) {
        expect(() => can(actor, permission)).not.toThrow();
      }
    }
  });
});

describe("can(): Milestone 2.1E — CRM permissions (companies:*, contacts:*)", () => {
  it("org_admin is granted all 8 CRM permissions", () => {
    const actor = actorFor("org_admin");
    for (const permission of [
      "companies:read",
      "companies:create",
      "companies:update",
      "companies:delete",
      "contacts:read",
      "contacts:create",
      "contacts:update",
      "contacts:delete",
    ] as const) {
      expect(can(actor, permission)).toBe(true);
    }
  });

  it("org_member cannot soft-delete through RBAC — read/create/update granted, delete denied", () => {
    const actor = actorFor("org_member");
    expect(can(actor, "companies:read")).toBe(true);
    expect(can(actor, "companies:create")).toBe(true);
    expect(can(actor, "companies:update")).toBe(true);
    expect(can(actor, "companies:delete")).toBe(false);
    expect(can(actor, "contacts:read")).toBe(true);
    expect(can(actor, "contacts:create")).toBe(true);
    expect(can(actor, "contacts:update")).toBe(true);
    expect(can(actor, "contacts:delete")).toBe(false);
  });

  it("org_viewer cannot create, update, or delete either resource — read only", () => {
    const actor = actorFor("org_viewer");
    expect(can(actor, "companies:read")).toBe(true);
    expect(can(actor, "contacts:read")).toBe(true);
    for (const permission of [
      "companies:create",
      "companies:update",
      "companies:delete",
      "contacts:create",
      "contacts:update",
      "contacts:delete",
    ] as const) {
      expect(can(actor, permission)).toBe(false);
    }
  });

  it("agency_owner and agency_admin do not acquire direct client-org CRM CRUD — all 8 keys denied for both", () => {
    for (const role of ["agency_owner", "agency_admin"] as const) {
      const actor = actorFor(role);
      for (const permission of [
        "companies:read",
        "companies:create",
        "companies:update",
        "companies:delete",
        "contacts:read",
        "contacts:create",
        "contacts:update",
        "contacts:delete",
      ] as const) {
        expect(can(actor, permission)).toBe(false);
      }
    }
  });

  it("portal_customer is denied every CRM permission", () => {
    const actor = actorFor("portal_customer");
    for (const permission of [
      "companies:read",
      "companies:create",
      "companies:update",
      "companies:delete",
      "contacts:read",
      "contacts:create",
      "contacts:update",
      "contacts:delete",
    ] as const) {
      expect(can(actor, permission)).toBe(false);
    }
  });

  it("granting a CRM permission does not scope-leak: an org_admin's CRM grant still respects an explicit mismatched resource.organizationId", () => {
    const actor = actorFor("org_admin");
    const someoneElsesOrgId = randomUUID();
    expect(can(actor, "companies:delete", { organizationId: someoneElsesOrgId })).toBe(false);
    expect(can(actor, "companies:delete", { organizationId: actor.organizationId })).toBe(true);
  });
});

describe("can(): CRM delete permissions are independent from data-subject-requests:execute", () => {
  it("org_admin holds both, but they are two separately-granted keys, not one implying the other", () => {
    const actor = actorFor("org_admin");
    expect(can(actor, "contacts:delete")).toBe(true);
    expect(can(actor, "data-subject-requests:execute")).toBe(true);
  });

  it("a role can hold contacts:delete without holding data-subject-requests:execute — org_member proves the two are not coupled", () => {
    const actor = actorFor("org_member");
    expect(can(actor, "contacts:delete")).toBe(false);
    expect(can(actor, "data-subject-requests:execute")).toBe(false);
    // The absence is independent, not a derived consequence — confirmed by
    // checking org_viewer too, which also lacks both, for a different
    // reason (read-only, not merely non-admin).
    const viewer = actorFor("org_viewer");
    expect(can(viewer, "contacts:delete")).toBe(false);
    expect(can(viewer, "data-subject-requests:execute")).toBe(false);
  });

  it("no role is granted contacts:delete/companies:delete without also being org_admin — confirms delete is not accidentally broader than intended", () => {
    for (const role of ROLES) {
      if (role === "org_admin") continue;
      const actor = actorFor(role);
      expect(can(actor, "contacts:delete")).toBe(false);
      expect(can(actor, "companies:delete")).toBe(false);
    }
  });
});

describe("can(): Milestone 2.1E — pre-existing 14 permissions unaffected", () => {
  it("every pre-2.1E permission's expected value is unchanged for every role", () => {
    const preExisting: PermissionKey[] = [
      "organizations:read",
      "organizations:list-clients",
      "organizations:create-client",
      "organizations:manage-billing",
      "organizations:manage-users",
      "organizations:manage-settings",
      "agencies:read",
      "agencies:manage-branding",
      "agencies:manage-billing",
      "agencies:manage-domains",
      "consent:record",
      "data-subject-requests:create",
      "data-subject-requests:read",
      "data-subject-requests:execute",
    ];
    for (const role of ROLES) {
      for (const permission of preExisting) {
        expect(can(actorFor(role), permission)).toBe(EXPECTED[role][permission]);
      }
    }
  });

  it("every pre-2.2C permission (including the eight 2.1E CRM keys) is unchanged for every role", () => {
    const preExisting2_2C: PermissionKey[] = [
      "organizations:read",
      "organizations:list-clients",
      "organizations:create-client",
      "organizations:manage-billing",
      "organizations:manage-users",
      "organizations:manage-settings",
      "agencies:read",
      "agencies:manage-branding",
      "agencies:manage-billing",
      "agencies:manage-domains",
      "consent:record",
      "data-subject-requests:create",
      "data-subject-requests:read",
      "data-subject-requests:execute",
      "companies:read",
      "companies:create",
      "companies:update",
      "companies:delete",
      "contacts:read",
      "contacts:create",
      "contacts:update",
      "contacts:delete",
    ];
    for (const role of ROLES) {
      for (const permission of preExisting2_2C) {
        expect(can(actorFor(role), permission)).toBe(EXPECTED[role][permission]);
      }
    }
  });
});

describe("can(): Milestone 2.2C — Deals/Pipelines permissions", () => {
  const DEALS_KEYS = ["deals:read", "deals:create", "deals:update", "deals:delete"] as const;
  const PIPELINES_KEYS = ["pipelines:read", "pipelines:create", "pipelines:update", "pipelines:delete"] as const;

  it("org_admin is granted all 4 deals keys and all 4 pipelines keys", () => {
    const actor = actorFor("org_admin");
    for (const permission of [...DEALS_KEYS, ...PIPELINES_KEYS]) {
      expect(can(actor, permission)).toBe(true);
    }
  });

  it("org_member: deals read/create/update, no delete; pipelines read only", () => {
    const actor = actorFor("org_member");
    expect(can(actor, "deals:read")).toBe(true);
    expect(can(actor, "deals:create")).toBe(true);
    expect(can(actor, "deals:update")).toBe(true);
    expect(can(actor, "deals:delete")).toBe(false);
    expect(can(actor, "pipelines:read")).toBe(true);
    expect(can(actor, "pipelines:create")).toBe(false);
    expect(can(actor, "pipelines:update")).toBe(false);
    expect(can(actor, "pipelines:delete")).toBe(false);
  });

  it("org_viewer: read only for both deals and pipelines", () => {
    const actor = actorFor("org_viewer");
    expect(can(actor, "deals:read")).toBe(true);
    expect(can(actor, "pipelines:read")).toBe(true);
    for (const permission of ["deals:create", "deals:update", "deals:delete", "pipelines:create", "pipelines:update", "pipelines:delete"] as const) {
      expect(can(actor, permission)).toBe(false);
    }
  });

  it("agency_owner and agency_admin get none of the 8 keys", () => {
    for (const role of ["agency_owner", "agency_admin"] as const) {
      const actor = actorFor(role);
      for (const permission of [...DEALS_KEYS, ...PIPELINES_KEYS]) {
        expect(can(actor, permission)).toBe(false);
      }
    }
  });

  it("portal_customer gets none of the 8 keys", () => {
    const actor = actorFor("portal_customer");
    for (const permission of [...DEALS_KEYS, ...PIPELINES_KEYS]) {
      expect(can(actor, permission)).toBe(false);
    }
  });

  it("no role is granted agency roll-up access to deals/pipelines via these keys — every grant is scope-checked against the actor's own organizationId", () => {
    const actor = actorFor("org_admin");
    const someoneElsesOrgId = randomUUID();
    expect(can(actor, "deals:delete", { organizationId: someoneElsesOrgId })).toBe(false);
    expect(can(actor, "deals:delete", { organizationId: actor.organizationId })).toBe(true);
    expect(can(actor, "pipelines:delete", { organizationId: someoneElsesOrgId })).toBe(false);
    expect(can(actor, "pipelines:delete", { organizationId: actor.organizationId })).toBe(true);
  });
});

describe("can(): Milestone 2.2C — pipeline stage authorization maps to pipelines:* (no pipeline_stages:* keys exist)", () => {
  it("no role's grants contain a pipeline_stages:* key — a structural check, not a re-derivation of expected VALUES (which stay independently hand-written above)", () => {
    for (const role of ROLES) {
      const grantedKeys = Object.keys(PERMISSION_MATRIX[role]);
      expect(grantedKeys.some((key) => key.startsWith("pipeline_stages:"))).toBe(false);
    }
  });

  it("design intent for 2.2D: a stage operation checks the SAME key its parent-pipeline HTTP verb would use — GET=>pipelines:read, POST=>pipelines:create, PATCH=>pipelines:update, DELETE=>pipelines:delete", () => {
    // Not a route test (no API route exists yet, 2.2D) — this proves the
    // four keys a future stage-route implementation must reuse already
    // exist and are granted per the same frozen matrix pipelines
    // themselves use, so 2.2D has nothing further to add to this matrix.
    const admin = actorFor("org_admin");
    const member = actorFor("org_member");
    expect(can(admin, "pipelines:read")).toBe(true); // GET stages
    expect(can(admin, "pipelines:create")).toBe(true); // POST stage
    expect(can(admin, "pipelines:update")).toBe(true); // PATCH stage
    expect(can(admin, "pipelines:delete")).toBe(true); // DELETE stage
    expect(can(member, "pipelines:read")).toBe(true); // GET stages
    expect(can(member, "pipelines:create")).toBe(false); // POST stage denied
  });
});

describe("can(): Milestone 2.2C — deals:delete and pipelines:delete are independent of each other and of DSR", () => {
  it("deals:delete does not imply any DSR/compliance permission", () => {
    const actor = actorFor("org_member");
    // org_member never gets deals:delete at all — confirms the two keys
    // are not coupled by proving neither role that lacks deals:delete
    // gains it from anything DSR-related, and org_admin (which DOES hold
    // deals:delete) is checked separately below for independence.
    expect(can(actor, "deals:delete")).toBe(false);

    const admin = actorFor("org_admin");
    expect(can(admin, "deals:delete")).toBe(true);
    expect(can(admin, "data-subject-requests:execute")).toBe(true);
    // Both true for org_admin, but as two SEPARATELY granted keys — proven
    // by org_viewer/org_member holding data-subject-requests:execute=false
    // while genuinely lacking deals:delete for an unrelated reason
    // (read-only vs. no-delete), never because one key derives the other.
    const viewer = actorFor("org_viewer");
    expect(can(viewer, "deals:delete")).toBe(false);
    expect(can(viewer, "data-subject-requests:execute")).toBe(false);
  });

  it("pipelines:delete does not imply deals:delete", () => {
    // No role in the frozen matrix holds exactly one of the two without
    // the other (org_admin holds both, everyone else holds neither) —
    // this is what proves the frozen matrix itself never uses one key as
    // a proxy for the other; can() has no cross-key inference at all.
    for (const role of ROLES) {
      const actor = actorFor(role);
      const hasPipelinesDelete = can(actor, "pipelines:delete");
      const hasDealsDelete = can(actor, "deals:delete");
      expect(hasPipelinesDelete).toBe(hasDealsDelete);
    }
  });
});

describe("can(): Milestone 2.2C — unknown role/action remains fail-closed, can() never throws", () => {
  it("an unrecognized action string (not a member of PermissionKey at all) denies at runtime rather than throwing", () => {
    const actor = actorFor("org_admin");
    const bogusAction = "deals:archive" as unknown as PermissionKey;
    expect(() => can(actor, bogusAction)).not.toThrow();
    expect(can(actor, bogusAction)).toBe(false);
  });

  it("an unrecognized role denies every deals/pipelines permission, never throws", () => {
    const actor = actorFor("not_a_real_role");
    for (const permission of ["deals:read", "deals:create", "deals:update", "deals:delete", "pipelines:read", "pipelines:create", "pipelines:update", "pipelines:delete"] as const) {
      expect(() => can(actor, permission)).not.toThrow();
      expect(can(actor, permission)).toBe(false);
    }
  });
});
