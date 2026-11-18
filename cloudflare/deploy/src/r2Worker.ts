/**
 * R2 object helpers using the Worker binding (see wrangler.toml [[r2_buckets]]).
 * API shape mirrors backend/lib/r2Storage.js for data routes.
 */
import { getEnv } from "./envContext.js";

export function isR2Configured(): boolean {
  return Boolean(getEnv().R2);
}

export function isR2ObjectKey(filePath: string | null | undefined): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const n = filePath.replace(/\\/g, "/");
  return n.startsWith("orgs/");
}

export function objectKeyMain(orgId: number, mediaId: number): string {
  return `orgs/${orgId}/media/${mediaId}/file`;
}

export function objectKeyThumb(orgId: number, mediaId: number): string {
  return `orgs/${orgId}/media/${mediaId}/thumbnail.jpg`;
}

export function objectKeyOrgMenuIcon(orgId: number): string {
  return `orgs/${orgId}/menu-icon.jpg`;
}

export async function putObjectFromBuffer(
  key: string,
  buffer: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const bucket = getEnv().R2;
  if (!bucket) throw new Error("R2 is not configured");
  const u8 = buffer instanceof Buffer ? new Uint8Array(buffer) : buffer;
  await bucket.put(key, u8, { httpMetadata: { contentType: contentType || "application/octet-stream" } });
}

export async function getObjectStream(key: string): Promise<{ body: ReadableStream; contentType?: string }> {
  const bucket = getEnv().R2;
  if (!bucket) throw new Error("R2 is not configured");
  const obj = await bucket.get(key);
  if (!obj || !obj.body) throw new Error("Empty R2 object body");
  return { body: obj.body, contentType: obj.httpMetadata?.contentType };
}

export async function deleteObjectKey(key: string): Promise<void> {
  const bucket = getEnv().R2;
  if (!bucket) return;
  await bucket.delete(key);
}
