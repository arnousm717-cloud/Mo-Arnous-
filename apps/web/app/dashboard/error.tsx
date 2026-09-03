"use client";

export default function DashboardError({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <main>
      <p role="alert">Something went wrong loading the dashboard.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
