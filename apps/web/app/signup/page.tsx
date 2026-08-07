"use client";

import { useActionState } from "react";
import { signupAction, type SignupFormState } from "./actions";

const initialState: SignupFormState = {};

export default function SignupPage(): React.ReactElement {
  const [state, formAction, isPending] = useActionState(signupAction, initialState);

  return (
    <main>
      <h1>Create your account</h1>
      <form action={formAction}>
        <label>
          Organization name
          <input type="text" name="orgName" required />
        </label>
        <label>
          Email
          <input type="email" name="email" required />
        </label>
        <label>
          Password
          <input type="password" name="password" required minLength={8} />
        </label>
        {state.error ? <p role="alert">{state.error}</p> : null}
        <button type="submit" disabled={isPending}>
          {isPending ? "Creating account…" : "Sign up"}
        </button>
      </form>
    </main>
  );
}
