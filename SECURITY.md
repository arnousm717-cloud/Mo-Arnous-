# Security Policy

AI Revenue OS is pre-launch and under active development. We still take security reports seriously and will respond promptly.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security report.**

Email **arnousm717@gmail.com** with the subject line `SECURITY: <short description>`. If you don't receive an acknowledgement within the timeframe below, please follow up — it's possible your email was missed, not ignored.

Please include, as applicable:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof-of-concept (minimal, non-destructive).
- The affected component, endpoint, or URL.
- Any relevant logs, request/response samples, or screenshots (with any personal data you don't own redacted).

## Scope

In scope:
- The AI Revenue OS application (`apps/web`) and its API (`/api/v1/*`).
- The underlying database schema, migrations, and RLS/authorization logic in this repository.

Out of scope:
- Third-party services we depend on (Vercel, Supabase, GitHub) — please report those directly to the respective vendor.
- Denial-of-service testing, spam, or social engineering against project maintainers or users.
- Automated scanning that generates significant load against shared infrastructure without prior coordination.

## Response Timing

- **Acknowledgement**: within 3 business days of your report.
- **Initial assessment** (severity, validity, expected remediation timeline): within 10 business days.
- We'll keep you updated as remediation progresses for anything confirmed valid.

## Safe Harbor

If you make a good-faith effort to comply with this policy while researching or reporting a vulnerability — including avoiding privacy violations, data destruction, and service disruption — we will not pursue legal action against you for that research. Please give us a reasonable opportunity to investigate and remediate before any public disclosure.

## Disclosure

We ask that you not publicly disclose a reported vulnerability until we've had a chance to remediate it and have mutually agreed on a disclosure timeline. We're happy to credit reporters (with permission) once a fix ships.
