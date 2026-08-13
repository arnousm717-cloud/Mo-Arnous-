import { NextResponse } from "next/server";
import { updateCompany, getCompanyById, softDeleteCompany, type UpdateCompanyInput } from "@ai-revenue-os/crm";
import { withIdempotency } from "../../_shared/idempotency";
import { resolveActor, mapCrmError, toCompanyResponseBody } from "../handlers";

/**
 * Milestone 2.1F-B. Cross-org and nonexistent :id are indistinguishable —
 * packages/crm's getCompanyById/updateCompany/softDeleteCompany already
 * return null for both cases identically; this file adds no special-casing
 * at all, it just maps null to 404 (matching the existing DSR-route
 * precedent, apps/web/app/api/v1/data-subject-requests/[id]/handlers.ts).
 */

/** hasOwnProperty-preserving extraction — a key is only present on the
 * returned object if it was actually present in the raw parsed body, so
 * packages/crm's own Object.prototype.hasOwnProperty-based partial-update
 * logic sees exactly what the client sent, never an accidental explicit
 * `undefined` for every omitted field. */
function extractUpdateInput(rawBody: unknown): UpdateCompanyInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const input: UpdateCompanyInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("name")) input.name = body.name as string;
  if (has("domain")) input.domain = body.domain as string | null;
  if (has("industry")) input.industry = body.industry as string | null;
  if (has("employeeCount")) input.employeeCount = body.employeeCount as number | null;
  if (has("annualRevenue")) input.annualRevenue = body.annualRevenue as number | string | null;
  if (has("linkedinUrl")) input.linkedinUrl = body.linkedinUrl as string | null;
  if (has("ownerId")) input.ownerId = body.ownerId as string | null;
  return input;
}

export async function handleGetCompany(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "companies:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const company = await getCompanyById(actor, id);
  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(toCompanyResponseBody(company));
}

export async function handleUpdateCompany(
  userId: string | null,
  id: string,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "companies:update");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractUpdateInput(rawBody);
  const route = `/api/v1/companies/${id}`;

  if (!idempotencyKey) {
    try {
      const company = await updateCompany(actor, id, input);
      if (!company) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(toCompanyResponseBody(company));
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to update company" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "PATCH", route, body: input },
      async (client) => {
        try {
          const company = await updateCompany(actor, id, input, client);
          if (!company) {
            return { status: 404, body: { error: "Not found" } };
          }
          return { status: 200, body: toCompanyResponseBody(company) };
        } catch (err) {
          const mapped = mapCrmError(err);
          if (mapped) {
            return mapped;
          }
          throw err;
        }
      },
    );

    if (outcome.kind === "conflict") {
      return NextResponse.json({ error: "Idempotency-Key already used with a different request" }, { status: 409 });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    return NextResponse.json({ error: "Failed to update company" }, { status: 500 });
  }
}

export async function handleDeleteCompany(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "companies:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const company = await softDeleteCompany(actor, id);
  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(toCompanyResponseBody(company));
}
