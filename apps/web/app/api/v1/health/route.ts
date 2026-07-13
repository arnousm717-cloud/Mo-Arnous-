export function GET(): Response {
  return Response.json({ status: "ok", service: "ai-revenue-os-web" });
}
