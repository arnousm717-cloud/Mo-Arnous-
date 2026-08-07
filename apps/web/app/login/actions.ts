"use server";

import { redirect } from "next/navigation";
import { AuthError, signInWithPassword } from "@ai-revenue-os/auth";

export interface LoginFormState {
  error?: string;
}

export async function loginAction(_prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const email = formData.get("email");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string") {
    return { error: "Email and password are required." };
  }

  try {
    await signInWithPassword(email, password);
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: err.message };
    }
    throw err;
  }

  redirect("/dashboard");
}
