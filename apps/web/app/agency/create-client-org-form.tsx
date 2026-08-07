"use client";

import { useActionState } from "react";
import { createClientOrgAction, type CreateClientOrgFormState } from "./actions";

const initialState: CreateClientOrgFormState = {};

export function CreateClientOrgForm(): React.ReactElement {
  const [state, formAction, isPending] = useActionState(createClientOrgAction, initialState);

  return (
    <form action={formAction}>
      <label>
        Organization name
        <input type="text" name="name" required disabled={isPending} />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button type="submit" disabled={isPending}>
        {isPending ? "Creating…" : "Create client organization"}
      </button>
    </form>
  );
}
