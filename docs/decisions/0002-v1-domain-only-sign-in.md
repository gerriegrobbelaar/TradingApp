# ADR 0002: v1 sign-in limited to camelthorncapital.com
Status: accepted 2026-11-10 (decision 8)
Only Google Workspace accounts with `hd = camelthorncapital.com` (and an admin invite) may sign in.
No external-email exception in v1: the "allow external email" option is not built.
The Google Cloud project / OAuth client ID is supplied via Workers vars (`GOOGLE_CLIENT_ID`) and secret (`GOOGLE_CLIENT_SECRET`); not needed to build or test.
