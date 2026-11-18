import { getWorkerKv } from "../envContext.js";
import { getRow, runDb } from "./db.cjs";

const PREFIX = "opdir:v1:st:";

export type OperatorDirRow = {
  station_code: string;
  name_with_phones: string | null;
  industry: string | null;
  last_refreshed_at: string | null;
};

function rowFromKvJson(stationCode: string, raw: string): OperatorDirRow | null {
  try {
    const j = JSON.parse(raw) as {
      nwp?: string | null;
      ind?: string | null;
      at?: string | null;
    };
    return {
      station_code: stationCode,
      name_with_phones: j.nwp != null ? String(j.nwp) : null,
      industry: j.ind != null ? String(j.ind) : null,
      last_refreshed_at: j.at != null ? String(j.at) : null,
    };
  } catch {
    return null;
  }
}

/** Authoritative: Workers KV. Falls back to D1 for legacy rows when key missing. */
export async function getOperatorDirOne(
  db: unknown,
  stationCode: string
): Promise<OperatorDirRow | null> {
  const rows = await getOperatorDirRows(db, [stationCode]);
  return rows[0] || null;
}

export async function getOperatorDirRows(
  db: unknown,
  stationCodes: string[]
): Promise<OperatorDirRow[]> {
  const out: OperatorDirRow[] = [];
  const kv = getWorkerKv();
  for (const code of stationCodes) {
    const c = String(code).trim();
    if (!c) continue;
    let row: OperatorDirRow | null = null;
    if (kv) {
      const json = await kv.get(PREFIX + c, "text");
      if (json) row = rowFromKvJson(c, json);
    }
    if (!row) {
      const d1 = (await getRow(
        db,
        `SELECT station_code, name_with_phones, industry, last_refreshed_at FROM station_operator_phones WHERE station_code = ?`,
        [c]
      )) as {
        station_code?: string;
        name_with_phones?: string;
        industry?: string;
        last_refreshed_at?: string;
      } | null;
      if (d1) {
        row = {
          station_code: String(d1.station_code),
          name_with_phones: d1.name_with_phones != null ? String(d1.name_with_phones) : null,
          industry: d1.industry != null ? String(d1.industry) : null,
          last_refreshed_at: d1.last_refreshed_at != null ? String(d1.last_refreshed_at) : null,
        };
      }
    }
    if (row) out.push(row);
  }
  return out;
}

export async function putOperatorDirRow(
  db: unknown,
  stationCode: string,
  nameWithPhones: string | null,
  industry: string | null
): Promise<void> {
  const c = String(stationCode).trim();
  if (!c) return;
  const at = new Date().toISOString();
  const payload = JSON.stringify({
    nwp: nameWithPhones,
    ind: industry,
    at,
  });
  const kv = getWorkerKv();
  if (kv) {
    await kv.put(PREFIX + c, payload);
    return;
  }
  await runDb(
    db,
    `INSERT INTO station_operator_phones (station_code, name_with_phones, industry, last_refreshed_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(station_code) DO UPDATE SET
       name_with_phones = COALESCE(NULLIF(excluded.name_with_phones, ''), station_operator_phones.name_with_phones),
       industry = COALESCE(NULLIF(excluded.industry, ''), station_operator_phones.industry),
       last_refreshed_at = CURRENT_TIMESTAMP`,
    [c, nameWithPhones, industry]
  );
}
