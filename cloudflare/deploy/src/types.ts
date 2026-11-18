import type { D1Database, Fetcher, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

/** Minimal Workflow binding shape (create/get instances). */
export type SubmitJobWorkflowBinding = {
  create: (options?: { id?: string; params?: { jobId: string } }) => Promise<{ id: string }>;
  get: (id: string) => Promise<{
    id: string;
    restart: () => Promise<unknown>;
    status: () => Promise<{ status: string }>;
  }>;
};

export type SendEmailBinding = {
  send(message: unknown): Promise<void>;
};

/** Cloudflare bindings + secrets (see wrangler.toml / dashboard) */
export type Env = {
  DB: D1Database;
  R2?: R2Bucket;
  /** App coordination keys (nGen list poll locks, operator directory, UI prefs, ticket hub) — see wrangler [[kv_namespaces]] */
  APP_KV?: KVNamespace;
  /** Cloudflare Email Routing outbound binding (see [[send_email]] in wrangler.toml). */
  SEND_EMAIL?: SendEmailBinding;
  JWT_SECRET: string;
  PASSWORD_RESET_SECRET?: string;
  PASSWORD_RESET_ORIGIN?: string;
  /** User-facing support address in API error copy and SECURITY.md. */
  SUPPORT_EMAIL?: string;
  /** From address for transactional mail (must match [[send_email]] allowed_sender_addresses). */
  TRANSACTIONAL_FROM_EMAIL?: string;
  /**
   * Access token lifetime for user JWTs (jose duration string, e.g. 12h, 7d, 30m).
   * Omit or set invalid value to use the Worker default (7d).
   */
  JWT_EXPIRY?: string;
  /** Optional: explicit public catalog org id (defaults to is_public_catalog = 1 row) */
  PUBLIC_CATALOG_ORG_ID?: string;
  /** Master key material for AES-GCM of `organization_pacweb_accounts.password_encrypted`. Prefer `wrangler secret put` before GA; beta may use `[vars]`. */
  NGEN_CREDENTIALS_KEY?: string;
  /** Optional prior primary during rotation (decrypt-only); unset after bulk repack. */
  NGEN_CREDENTIALS_KEY_OLD?: string;
  /** Shared secret for `POST /api/internal/credential-repack-masters` (header `X-Ngen-Credential-Repack-Secret`). */
  NGEN_CREDENTIAL_REPACK_SECRET?: string;
  /** Public API origin. Signup verify links use this. Repack falls back here only if CREDENTIAL_REPACK_ORIGIN is unset. */
  WORKER_ORIGIN?: string;
  /** workers.dev origin for the post-deploy repack POST. Not read by request handlers. */
  CREDENTIAL_REPACK_ORIGIN?: string;
  /** Global nGen / USAN service login (optional). Used only when APP_ENV is development, dev, test, or local and poll mode is not per_organization. */
  USAN_SERVICE_USERNAME?: string;
  USAN_SERVICE_PASSWORD?: string;
  USAN_POLL_CREDENTIALS_MODE?: string;
  /** Throttle nGen EnquirySearch calls during list poll (ms). */
  USAN_POLL_NGEN_THROTTLE_MS?: string;
  NGEN_USER?: string;
  NGEN_PASS?: string;
  USAN_USER?: string;
  USAN_PASS?: string;
  /** Nightly nGen list sync hub org (preferred). */
  USAN_SCHEDULE_ORG_ID?: string;
  USAN_SCHEDULE_USER_ID?: string;
  PAC_SEARCH_DATE_OPTION?: string;
  PACWEB_POLL_MAX_NEW?: string;
  PAC_ENRICHMENT_DAYS_BACK?: string;
  NGEN_ACCESS_TOKEN_CACHE?: string;
  NGEN_ACCESS_TOKEN_CACHE_TTL_MS?: string;
  /** Deployment environment marker. Use "production" for deployed Workers. */
  APP_ENV?: string;
  /** When `"1"`, Ticket Hub bulk renewal (POST /api/tickets/renew) is enabled. */
  ENABLE_TICKET_RENEWAL?: string;
  /**
   * Comma-separated browser origins allowed for CORS (required in production when BUILTIN_CORS_ORIGINS is empty).
   * Set to `*` alone to allow any origin. Omit to use built-in defaults only.
   */
  CORS_ORIGINS?: string;
  /**
   * USAN org list / PAC poll cooperative lock (string integer ms).
   * See `getCooperativeLockMs` in `lib/timeouts.cjs`.
   */
  COOPERATIVE_LOCK_MS?: string;
  /**
   * Per-ticket nGen full-detail refresh skip window (string integer ms).
   * See `getTicketDetailCoopLockMs` in `lib/timeouts.cjs`. Exposed via GET /api/public-config.
   */
  TICKET_DETAIL_COOP_LOCK_MS?: string;
  /** Durable submit-job Workflow (one step per dig site / ticket). */
  SUBMIT_JOB_WORKFLOW?: SubmitJobWorkflowBinding;
  /** Workers static assets (Core UI served from the same Worker). */
  ASSETS?: Fetcher;
};

export type AuthUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  organizationId?: number;
  adminOrganizationIds: number[];
  organizationIds: number[];
  fullName?: string | null;
};
