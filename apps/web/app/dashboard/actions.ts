"use server";

import { redirect } from "next/navigation";
import { signOut } from "@ai-revenue-os/auth";

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
