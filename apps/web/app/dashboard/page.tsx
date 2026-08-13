import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import { getOrganizationById } from "@ai-revenue-os/tenancy";
import { logoutAction } from "./actions";

export default async function DashboardPage(): Promise<React.ReactElement> {
  const context = await resolveRequestContext();
  if (!context) {
    redirect("/login");
  }
  if (!context.organizationId) {
    // Authenticated but no organization yet — shouldn't normally happen
    // given signup always creates one, but handled explicitly rather than
    // crashing if it ever does (e.g. a future invite-only membership flow).
    return (
      <main>
        <p>Your account isn&apos;t linked to an organization yet.</p>
      </main>
    );
  }

  const organization = await getOrganizationById({
    userId: context.userId,
    organizationId: context.organizationId,
  });

  return (
    <main>
      <h1>Welcome, {organization?.name ?? "there"}</h1>
      <p>Role: {context.roleKey}</p>
      <nav>
        <Link href="/companies">Companies</Link>
        {" | "}
        <Link href="/contacts">Contacts</Link>
      </nav>
      <form action={logoutAction}>
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
