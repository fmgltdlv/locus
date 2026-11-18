/**
 * Bulk decrypt/re-encrypt master PAC/nGen passwords under the current `NGEN_CREDENTIALS_KEY`.
 * Requires `NGEN_CREDENTIAL_REPACK_SECRET` and header `X-Ngen-Credential-Repack-Secret`.
 * @see docs/DEPLOYMENT.md
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Env } from "../types.js";
import {
  decryptPassword,
  encryptPassword,
  getNgenPrimaryKeyFingerprint,
} from "../lib/pacwebCredentialsCrypto.cjs";

const KV_FP_KEY = "credential_repack:primary_fp";

const BATCH_LIMIT = 80;

function repackSecretOk(env: Env, headerVal: string | undefined): boolean {
  const expected = String(env.NGEN_CREDENTIAL_REPACK_SECRET || "").trim();
  if (!expected) return false;
  const got = String(headerVal || "").trim();
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(got, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

type MasterRow = {
  id: number;
  organization_id: number;
  password_encrypted: string;
};

const credentialRepack = new Hono<{ Bindings: Env }>() as any;

credentialRepack.post("/credential-repack-masters", async (c) => {
  if (!String(c.env.NGEN_CREDENTIAL_REPACK_SECRET || "").trim()) {
    return c.json(
      { error: "NGEN_CREDENTIAL_REPACK_SECRET is not configured on the Worker" },
      503
    );
  }
  if (!repackSecretOk(c.env, c.req.header("X-Ngen-Credential-Repack-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!c.env.DB) {
    return c.json({ error: "Database not configured" }, 500);
  }
  if (!c.env.APP_KV) {
    return c.json({ error: "APP_KV binding required for credential repack fingerprint" }, 503);
  }

  const currentFp = getNgenPrimaryKeyFingerprint();
  if (!currentFp) {
    return c.json(
      {
        error: "NGEN_CREDENTIALS_KEY is not set; cannot determine fingerprint or encrypt",
      },
      400
    );
  }

  const force = c.req.query("force") === "1" || c.req.query("force") === "true";

  const storedFp = await c.env.APP_KV.get(KV_FP_KEY);
  if (!force && storedFp && storedFp === currentFp) {
    return c.json({
      ok: true,
      complete: true,
      skipped: true,
      rowsUpdated: 0,
      fingerprintMatches: true,
      message: "Stored fingerprint matches NGEN_CREDENTIALS_KEY; no work performed. Pass force=1 to re-run.",
    });
  }

  const t0 = Date.now();
  let rowsUpdated = 0;
  let lastId = 0;

  for (;;) {
    const rs = await c.env.DB.prepare(
      `SELECT id, organization_id, password_encrypted
       FROM organization_pacweb_accounts
       WHERE account_type = 'master'
         AND password_encrypted IS NOT NULL
         AND LENGTH(TRIM(COALESCE(password_encrypted, ''))) > 0
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`
    )
      .bind(lastId, BATCH_LIMIT)
      .all();

    const rows = (rs.results || []) as MasterRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const stored = row.password_encrypted != null ? String(row.password_encrypted) : "";
      if (!stored.trim()) continue;

      let plaintext: string;
      try {
        plaintext = await decryptPassword(stored);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json(
          {
            ok: false,
            error: "Decrypt failed for master row; aborting batch",
            accountId: row.id,
            organizationId: row.organization_id,
            detail: msg,
          },
          500
        );
      }

      let enc: string;
      try {
        enc = await encryptPassword(plaintext);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json(
          {
            ok: false,
            error: "Encrypt failed for master row; aborting batch",
            accountId: row.id,
            organizationId: row.organization_id,
            detail: msg,
          },
          500
        );
      }

      await c.env.DB.prepare(
        `UPDATE organization_pacweb_accounts
         SET password_encrypted = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND organization_id = ?`
      )
        .bind(enc, row.id, row.organization_id)
        .run();

      rowsUpdated += 1;
      lastId = row.id;
    }

    if (rows.length < BATCH_LIMIT) break;
  }

  await c.env.APP_KV.put(KV_FP_KEY, currentFp);

  const durationMs = Date.now() - t0;
  return c.json({
    ok: true,
    complete: true,
    skipped: false,
    rowsUpdated,
    fingerprintStored: currentFp,
    durationMs,
  });
});

export { credentialRepack };
