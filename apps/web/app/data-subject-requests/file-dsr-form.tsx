"use client";

import { useActionState } from "react";
import { fileDsrAction, type FileDsrFormState } from "./actions";

const initialState: FileDsrFormState = {};

/**
 * M1.6 scope: only subject_type="user" (a staff account) has any
 * fulfillment logic — the other three schema-valid types are exposed here
 * because the underlying API accepts them, but filing one succeeds while
 * leaving nothing able to act on it, so this form only offers "user".
 */
export function FileDsrForm(): React.ReactElement {
  const [state, formAction, isPending] = useActionState(fileDsrAction, initialState);

  return (
    <form action={formAction}>
      <input type="hidden" name="subjectType" value="user" />
      <label>
        Subject user id (public.users.id / auth.users.id)
        <input type="text" name="subjectId" required disabled={isPending} />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button type="submit" disabled={isPending}>
        {isPending ? "Filing…" : "File erasure request"}
      </button>
    </form>
  );
}
