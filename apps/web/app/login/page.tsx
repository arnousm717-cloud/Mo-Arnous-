"use client";

import { useActionState } from "react";
import { loginAction, type LoginFormState } from "./actions";

const initialState: LoginFormState = {};

export default function LoginPage(): React.ReactElement {
  const [state, formAction, isPending] = useActionState(loginAction, initialState);

  return (
    <main>
      <h1>Log in</h1>
      <form action={formAction}>
        <label>
          Email
          <input type="email" name="email" required />
        </label>
        <label>
          Password
          <input type="password" name="password" required />
        </label>
        {state.error ? <p role="alert">{state.error}</p> : null}
        <button type="submit" disabled={isPending}>
          {isPending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}
