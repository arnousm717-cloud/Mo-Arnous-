// TEMPORARY — M1.8 manual staging verification only (Preview deployment,
// feat/m1.8-observability-dependency-hygiene branch). Removed before
// closeout; never merged to main.
export async function GET(request: Request): Promise<Response> {
  void request;
  throw new Error(
    "m18-staging-verification-marker-9f3k2 for staging-verify@example.com using arev_live_stagingverifysecret001",
  );
}
