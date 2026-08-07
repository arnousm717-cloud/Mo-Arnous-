"use client";

export default function AgencyConsoleError({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <main>
      <p role="alert">Something went wrong loading the agency console.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
