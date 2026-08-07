"use server";

import { redirect } from "next/navigation";
import { AuthError, signUpWithPassword } from "@ai-revenue-os/auth";
import { createOrganizationForNewUser } from "@ai-revenue-os/tenancy";

export interface SignupFormState {
  error?: string;
}

export async function signupAction(_prevState: SignupFormState, formData: FormData): Promise<SignupFormState> {
  const email = formData.get("email");
  const password = formData.get("password");
  const orgName = formData.get("orgName");

  if (typeof email !== "string" || typeof password !== "string" || typeof orgName !== "string") {
    return { error: "All fields are required." };
  }
  if (!orgName.trim()) {
    return { error: "Organization name is required." };
  }

  let userId: string;
  let sessionActive: boolean;
  try {
    const result = await signUpWithPassword(email, password);
    userId = result.userId;
    sessionActive = result.sessionActive;
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: err.message };
    }
    throw err;
  }

  // Deliberately a second step, not folded into signUpWithPassword itself —
  // the auth.users -> public.users sync is atomic via trigger, and
  // org+membership creation is atomic via the SECURITY DEFINER function,
  // but the two are sequential because GoTrue (the Auth service) and our
  // own schema are not one transaction spanning an HTTP call (ADR-004).
  // This works regardless of whether email confirmation is pending, because
  // it authorizes via the userId Supabase Auth just gave us directly, not
  // via a fully-established session (see AuthResult.sessionActive's doc).
  await createOrganizationForNewUser(userId, orgName);

  if (!sessionActive) {
    redirect("/signup/check-email");
  }
  redirect("/dashboard");
}
