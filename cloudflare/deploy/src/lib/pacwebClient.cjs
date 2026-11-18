/**
 * Nevada POSR Plan Access Centre (pacweb): session login + GetUserContext + GetEnquiryBySubset.
 * Login matches the browser: multipart/form-data with emailOrUserName + password (see HAR).
 *
 * **IsMyJobsView (GetEnquiryBySubset):** In this app the default is **`false`** — jobs **shared with** the
 * service user (e.g. customer tickets). Use **`true`** only for the service user’s **own** jobs.
 */
const crypto = require('crypto');
const { parseSetCookie } = require('set-cookie-parser');

const BASE = 'https://appsnv.undergroundservicealert.org/posr/pacweb';
const LOGIN_URL = `${BASE}/Account/Login`;
/** Default return path from live login page (matches browser redirect chain to dashboard APIs). */
const DEFAULT_RETURN_PATH = '/posr/pacweb/jobs/DashboardMain';
const API_USER_CONTEXT = `${BASE}/PlanAccessCentre/api/jobs/GetUserContext`;
const API_ENQUIRY_SUBSET = `${BASE}/PlanAccessCentre/api/jobs/GetEnquiryBySubset`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** PAC GetEnquiryBySubset: which date field FromDateCreatedInput/ToDateCreatedInput apply to. Env: PAC_SEARCH_DATE_OPTION */
function getPacSearchDateOption() {
  const raw = String(process.env.PAC_SEARCH_DATE_OPTION || '').trim().toLowerCase();
  if (raw === 'legalstart') return 'legalstart';
  return 'createdon';
}

/**
 * Explicit `searchDateOption` from API opts wins; otherwise env `PAC_SEARCH_DATE_OPTION`.
 * @param {string} [explicit]
 * @returns {'createdon'|'legalstart'}
 */
function resolveSearchDateOption(explicit) {
  const e = explicit != null ? String(explicit).trim().toLowerCase() : '';
  if (e === 'legalstart' || e === 'createdon') return e;
  return getPacSearchDateOption();
}

/**
 * @param {Array<[string, string]>} pairs
 * @param {string} boundary
 */
function buildMultipartBody(pairs, boundary) {
  const chunks = [];
  for (const [name, value] of pairs) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

/**
 * node-fetch joins multiple Set-Cookie headers with ", " in headers.get() — that breaks parsing.
 * Prefer headers.raw() when present; otherwise Web Fetch (Workers, undici) headers.getSetCookie().
 * @param {import('node-fetch').Response} response
 * @returns {string[]|null}
 */
function getRawSetCookieList(response) {
  if (!response || !response.headers) return null;
  if (typeof response.headers.raw === 'function') {
    const raw = response.headers.raw();
    if (!raw) return null;
    const key = Object.keys(raw).find((k) => k.toLowerCase() === 'set-cookie');
    if (!key || !raw[key] || !raw[key].length) return null;
    return raw[key];
  }
  if (typeof response.headers.getSetCookie === 'function') {
    const list = response.headers.getSetCookie();
    if (!list || !list.length) return null;
    return list;
  }
  return null;
}

class CookieJar {
  constructor() {
    /** @type {Record<string, string>} */
    this.map = {};
  }
  addFromResponse(response) {
    const list = getRawSetCookieList(response);
    if (!list) return;
    const cookies = parseSetCookie(list, { decodeValues: false });
    for (const c of cookies) {
      if (c && c.name) this.map[c.name] = c.value;
    }
  }
  header() {
    return Object.entries(this.map)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

/**
 * @param {string} html
 * @returns {string|null}
 */
function extractRequestVerificationToken(html) {
  const m =
    html.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/) ||
    html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/) ||
    html.match(/__RequestVerificationToken["\s]+value="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * @param {string} html
 * @param {string} name
 * @returns {string}
 */
function hiddenInputValue(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<input[^>]+name="${esc}"[^>]*>`, 'i'));
  if (!tag) return '';
  const vm = tag[0].match(/\bvalue="([^"]*)"/i);
  return vm ? vm[1] : '';
}

/**
 * @param {import('node-fetch').Response} res
 * @param {string} label
 * @returns {Promise<object>}
 */
async function readJsonOrThrow(res, label) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label}: not JSON (${res.status}): ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object'
        ? String(
            data.Message ??
              data.message ??
              data.error ??
              data.title ??
              text.slice(0, 400)
          )
        : text.slice(0, 400);
    throw new Error(`${label} failed (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Matches browser POST body from Dashboard (see HAR GetEnquiryBySubset) — omitting fields causes server 500.
 * @param {string} fromDate
 * @param {string} toDate
 * @param {object} [ctx] GetUserContext result; fills PelicanId / CompanyId when present
 * @param {{ isMyJobsView?: boolean, searchDateOption?: 'createdon'|'legalstart' }} [opts] **`false` or omit** — jobs **shared with** the service user (customer tickets; app default).
 *   **`true`** — only the service user’s **own** jobs. Optional **`searchDateOption`** overrides env for this request.
 */
function buildGetEnquiryBySubsetBody(fromDate, toDate, ctx, opts) {
  const isMyJobsView = Boolean(opts && opts.isMyJobsView === true);
  const pelican =
    ctx && ctx.PelicanId != null && String(ctx.PelicanId).trim() !== ''
      ? String(ctx.PelicanId)
      : '';
  const company =
    ctx && ctx.CompanyId != null && String(ctx.CompanyId).trim() !== ''
      ? String(ctx.CompanyId)
      : '';
  return {
    IsMyJobsView: isMyJobsView,
    AreClosedJobsIncluded: false,
    UtilityResponseCount: '',
    FromJobNumber: '',
    ToJobNumber: '',
    FromSequenceNumber: '',
    ToSequenceNumber: '',
    FromPercentComplete: '',
    ToPercentComplete: '',
    FromDateCreatedInput: fromDate,
    ToDateCreatedInput: toDate,
    HasExpiredPlans: false,
    HasPastCompletionDate: false,
    HasNoSpatialData: false,
    ShowClosedJobsOnly: false,
    PlansReceivedInput: '',
    BatchAction: 'First',
    JobsTableLimit: 50,
    FirstBatchIndex: 0,
    LastBatchIndex: 49,
    JobSorting: 'DateRequested',
    ActiveSortOrder: -1,
    IsOneCallPAC: false,
    SearchDateOption: resolveSearchDateOption(opts && opts.searchDateOption),
    FetchOffset: 0,
    Status: '',
    SearchKeyword: '',
    SelectedStatus: '',
    PelicanId: pelican,
    CompanyId: company,
  };
}

/**
 * Log in and warm dashboard; returns cookie jar + Referer used for APIs and downloads.
 * @param {import('node-fetch')} fetch
 * @param {{ username: string, password: string, returnPath?: string }} opts
 * @returns {Promise<{ jar: CookieJar, dashboardReferer: string }>}
 */
async function pacwebEstablishSession(fetch, opts) {
  const username = String(opts.username || '').trim();
  const password = String(opts.password || '');
  if (!username || !password) {
    throw new Error('username and password are required');
  }

  const jar = new CookieJar();
  const returnPath =
    (opts.returnPath && String(opts.returnPath).trim()) || DEFAULT_RETURN_PATH;
  const loginGetUrl = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnPath)}`;

  const loginGet = await fetch(loginGetUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': USER_AGENT,
    },
  });
  if (!loginGet.ok) {
    throw new Error(`GET Login failed: ${loginGet.status}`);
  }
  jar.addFromResponse(loginGet);
  const loginHtml = await loginGet.text();
  const csrf = extractRequestVerificationToken(loginHtml);
  if (!csrf) {
    throw new Error('Could not find __RequestVerificationToken on PAC login page');
  }

  const returnUrlField = hiddenInputValue(loginHtml, 'ReturnUrl') || returnPath;
  let screenH = hiddenInputValue(loginHtml, 'ScreenHeight');
  let screenW = hiddenInputValue(loginHtml, 'ScreenWidth');
  if (!screenH) screenH = '1039';
  if (!screenW) screenW = '1920';

  const boundary = '----NodeFormBoundary' + crypto.randomBytes(16).toString('hex');
  const postBody = buildMultipartBody(
    [
      ['ReturnUrl', returnUrlField],
      ['ScreenHeight', screenH],
      ['ScreenWidth', screenW],
      ['emailOrUserName', username],
      ['password', password],
      ['__RequestVerificationToken', csrf],
    ],
    boundary
  );

  const loginPageReferer = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnUrlField)}`;

  let res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Origin: new URL(BASE).origin,
      Referer: loginPageReferer,
      Cookie: jar.header(),
      'User-Agent': USER_AGENT,
    },
    body: postBody,
  });

  let referer = loginPageReferer;
  for (let hop = 0; hop < 12 && res.status >= 300 && res.status < 400; hop++) {
    jar.addFromResponse(res);
    let loc = res.headers.get('location');
    if (!loc) break;
    if (loc.startsWith('/')) loc = `${new URL(BASE).origin}${loc}`;
    res = await fetch(loc, {
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        Cookie: jar.header(),
        Referer: referer,
        'User-Agent': USER_AGENT,
      },
    });
    referer = loc;
  }
  jar.addFromResponse(res);

  if (res.status === 200) {
    const page = await res.text();
    if (
      /name="emailOrUserName"/i.test(page) &&
      (/Account\/Login/i.test(page) || /\/Account\/Login/i.test(page))
    ) {
      throw new Error(
        'PAC login failed: still on login page after POST (check credentials / CSRF / form fields).'
      );
    }
  }

  const dashWarm = await fetch(`${BASE}/jobs/DashboardMain`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: jar.header(),
      Referer: `${BASE}/jobs/MainDashboard`,
      'User-Agent': USER_AGENT,
    },
  });
  jar.addFromResponse(dashWarm);
  await dashWarm.text();

  const dashboardReferer = `${BASE}/jobs/DashboardMain`;
  return { jar, dashboardReferer };
}

/**
 * After login + dashboard warm-up: GetUserContext then GetEnquiryBySubset (same as dashboard job table).
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} dashboardReferer
 * @param {string} fromDate e.g. "15 Jan 2026"
 * @param {string} toDate
 * @param {{ isMyJobsView?: boolean }} [subsetOpts] omit or `false` = shared jobs (default); `true` = own jobs only
 * @returns {Promise<{ context: object, jobs: object }>}
 */
async function pacwebGetContextAndJobs(fetch, jar, dashboardReferer, fromDate, toDate, subsetOpts) {
  const fromD = String(fromDate || '').trim() || '02 Mar 2026';
  const toD = String(toDate || '').trim() || '02 Apr 2026';

  const ctxRes = await fetch(API_USER_CONTEXT, {
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json;charset=utf-8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: jar.header(),
      Referer: dashboardReferer,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  jar.addFromResponse(ctxRes);
  const context = await readJsonOrThrow(ctxRes, 'GetUserContext');

  const enquiryBody = buildGetEnquiryBySubsetBody(fromD, toD, context, subsetOpts);
  const jobsRes = await fetch(API_ENQUIRY_SUBSET, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: new URL(BASE).origin,
      Cookie: jar.header(),
      Referer: dashboardReferer,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(enquiryBody),
  });
  jar.addFromResponse(jobsRes);
  const jobs = await readJsonOrThrow(jobsRes, 'GetEnquiryBySubset');
  return { context, jobs };
}

/**
 * @param {import('node-fetch')} fetch
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} [opts.fromDate]
 * @param {string} [opts.toDate]
 * @param {boolean} [opts.contextOnly]
 * @param {string} [opts.returnPath] default /posr/pacweb/jobs/DashboardMain
 * @param {boolean} [opts.isMyJobsView] default **false** (shared / customer jobs); set **true** for the service user’s own jobs only
 * @param {'createdon'|'legalstart'} [opts.searchDateOption] override `PAC_SEARCH_DATE_OPTION` for this list call
 * @returns {Promise<{ context: object, jobs?: object }>}
 */
async function pacwebListJobs(fetch, opts) {
  const username = String(opts.username || '').trim();
  const password = String(opts.password || '');
  if (!username || !password) {
    throw new Error('username and password are required');
  }

  const fromD = opts.fromDate || '02 Mar 2026';
  const toD = opts.toDate || '02 Apr 2026';
  const contextOnly = Boolean(opts.contextOnly);

  const { jar, dashboardReferer } = await pacwebEstablishSession(fetch, {
    username,
    password,
    returnPath: opts.returnPath,
  });

  const ctxRes = await fetch(API_USER_CONTEXT, {
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json;charset=utf-8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: jar.header(),
      Referer: dashboardReferer,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  jar.addFromResponse(ctxRes);
  const context = await readJsonOrThrow(ctxRes, 'GetUserContext');

  if (contextOnly) {
    return { context };
  }

  const enquiryBody = buildGetEnquiryBySubsetBody(fromD, toD, context, {
    isMyJobsView: opts.isMyJobsView === true,
    searchDateOption: opts.searchDateOption,
  });

  const jobsRes = await fetch(API_ENQUIRY_SUBSET, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: new URL(BASE).origin,
      Cookie: jar.header(),
      Referer: dashboardReferer,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(enquiryBody),
  });
  jar.addFromResponse(jobsRes);
  const jobs = await readJsonOrThrow(jobsRes, 'GetEnquiryBySubset');

  return { context, jobs };
}

/** Public surface used by routes; other helpers stay module-private. */
module.exports = {
  pacwebListJobs,
  pacwebEstablishSession,
  pacwebGetContextAndJobs,
  /** For tests / session reuse: `Object.assign(new CookieJar().map, stored)` */
  CookieJar,
};
