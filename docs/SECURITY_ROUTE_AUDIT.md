# Security route audit

This audit tracks which API surfaces are public, authenticated, and organization-scoped. Update it when adding or moving Worker routes.

## Worker mounts

| Mount | Public? | Auth pattern | Org / permission pattern |
| --- | --- | --- | --- |
| `GET /health` | Yes | None | Health only; no app data. |
| `GET /api/public-config` | Yes | None | Non-secret UI flags only. |
| `/api/auth` | Mixed | Login, forgot-password, and reset-password are public; `/me` and `/logout` use `authMiddleware`. | Logout bumps `session_version`; `/me` returns the authenticated user's org memberships. Forgot-password uses a generic response and per-email throttle. `POST /login` is app-throttled per IP (20 failures / 15 min) and per account identifier (5 failures / 15 min) via `APP_KV` with D1 fallback; returns generic `Invalid credentials` when limited. Zone WAF also has a coarse `/api/*` backstop. |
| `/api/organizations` | No | Router uses `authMiddleware`. | Uses `canAccessOrganization`, `canAdminOrganization`, and `authorizeMiddleware('dev')` for privileged writes/deletes. |
| `/api/organizations/:orgId/*-accounts` | No | Router uses `authMiddleware`. | Account routes require org access/admin checks before credential reads/writes. |
| `/api/users` | No | Router uses `authMiddleware`. | Dev/admin only for user management; admins are constrained to organizations they administer. Password updates bump `session_version`. |
| `/api/user-organizations` | No | Router uses `authMiddleware`. | Dev/admin only for membership management. |
| `/api/public` | No | Router uses `authMiddleware` despite the route name. | Public-catalog reads are still mediated by authenticated eligibility checks. |
| `/api/feedback` | No | Router uses `authMiddleware`. | Org access checked before org-scoped feedback operations. |
| `/api/service-requests` | No | Router uses `authMiddleware`. | Org access checked before org-scoped operations. |
| `/api/geocoding` | No | Router uses `authMiddleware`. | Includes an app-level geocoding rate limiter; no org data writes. |
| `/api/data` | No, except media token links | Router uses `authMiddleware`; `/media/:id/file` and `/media/:id/thumbnail` allow `?token=` public access for signed media links. | Uses `requireOrganizationMiddleware`, `resolveDataOrgIdRead`, `canAccessOrganization`, or `canMutateOrganization` depending on read/write behavior. |
| `/api/tickets` | No | Router uses `authMiddleware`. | Ticket list/detail/write routes use org access checks and dev-ticket-hub checks where applicable. Job project membership (`POST`/`DELETE` `/job-projects/:jobNameKey/tickets`) and share-link management (`POST`/`GET`/`DELETE` `/job-projects/:jobNameKey/share-link`) require org admin + owner-org write access. |
| `/api/public/project-share` | Yes (public-id-scoped) | No JWT; requires an enabled `job_project_share_links.token` equal to the project’s stable 10-char `public_id` (case-insensitive). | Returns read-only project tickets, intersecting aerial maps, geotagged photos, and ticket detail/operator responses for tickets in the link’s effective project membership. Excludes compliance, notes, and principal contact PII. Media routes (`/media/:id/file`, `/media/:id/thumbnail`) only serve photos linked in `media_ticket_intersections` for project tickets. |
| `/api/admin` | No | Router uses `authMiddleware`. | Admin inbox routes check admin/dev access before returning org-scoped data. |
| `/api/internal/credential-repack-masters` | Secret-protected | No JWT; requires `X-Ngen-Credential-Repack-Secret`. | Internal maintenance only; uses timing-safe secret comparison and requires `APP_KV`. |

## Recent route checks

- `GET /api/data/media/photo-tags` resolves the readable organization with `resolveDataOrgIdRead`; public catalog organizations return only the built-in vocabulary.
- `PATCH /api/data/media/:id` resolves `organizationId`, checks `canAccessOrganization`, and updates only rows matching `id` and `organization_id`.
- `GET /api/data/media/:id/file` and `/thumbnail` require either a valid media token for that media id or normal authenticated media-read access.
- `GET /api/public/project-share/:token` and sub-routes validate the project’s stable 10-char alphanumeric `public_id` (case-insensitive) and that sharing is enabled (not revoked) before returning org-scoped ticket/map/photo data; no broader org or user session is granted. Disable/re-enable keeps the same ID; old 64-char hex share URLs are invalid after migration `0060_job_project_public_id`.
- `PATCH /api/data/aerial-maps/:id/access` and `PUT /api/data/aerial-maps/:id/orgs` are dev-only; they set `access_mode` (`global` / `restricted` / `hidden`) and per-map org allowlists. End-user aerial discovery (`GET /aerial-maps/for-view`, `GET /aerial-maps/accessible`, favorites, public catalog search, project-share aerial maps) filters by org access server-side. Tile URLs point at public GCS objects — restriction is metadata/discovery gating, not bucket ACLs.

## Review checklist for new routes

- Public routes must return only non-secret data and should be explicitly listed above.
- Authenticated routes should use router-level `authMiddleware` unless they have a documented alternate secret.
- Any route that accepts `organizationId`, `orgId`, ticket id, media id, or user id must prove the authenticated user can access or administer that organization before reading or writing.
- Password updates must bump `users.session_version` so existing JWTs are invalidated.
- Public media token links must be scoped to the specific resource id, expire, and avoid exposing broader org access. Project share links use a stable 10-char `public_id` with admin enable/disable (same ID on re-enable).
