import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { can, type Actor, type PermissionKey } from "../src/permissions";

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
    // org_viewer has zero write-adjacent permissions granted at all.
    const actor = actorFor("org_viewer");
    for (const permission of PERMISSIONS) {
      if (permission === "organizations:read") continue;
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
