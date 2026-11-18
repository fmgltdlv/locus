var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw new Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// ../../backend/node_modules/set-cookie-parser/dist/set-cookie.cjs
var require_set_cookie = __commonJS({
  "../../backend/node_modules/set-cookie-parser/dist/set-cookie.cjs"(exports, module) {
    var defaultParseOptions = {
      decodeValues: true,
      map: false,
      silent: false,
      split: "auto"
      // auto = split strings but not arrays
    };
    function isForbiddenKey(key) {
      return typeof key !== "string" || key in {};
    }
    function createNullObj() {
      return /* @__PURE__ */ Object.create(null);
    }
    function isNonEmptyString(str) {
      return typeof str === "string" && !!str.trim();
    }
    function parseString(setCookieValue, options) {
      var parts = setCookieValue.split(";").filter(isNonEmptyString);
      var nameValuePairStr = parts.shift();
      var parsed = parseNameValuePair(nameValuePairStr);
      var name = parsed.name;
      var value = parsed.value;
      options = options ? Object.assign({}, defaultParseOptions, options) : defaultParseOptions;
      if (isForbiddenKey(name)) {
        return null;
      }
      try {
        value = options.decodeValues ? decodeURIComponent(value) : value;
      } catch (e) {
        console.error(
          "set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.",
          e
        );
      }
      var cookie = createNullObj();
      cookie.name = name;
      cookie.value = value;
      parts.forEach(function(part) {
        var sides = part.split("=");
        var key = sides.shift().trimLeft().toLowerCase();
        if (isForbiddenKey(key)) {
          return;
        }
        var value2 = sides.join("=");
        if (key === "expires") {
          cookie.expires = new Date(value2);
        } else if (key === "max-age") {
          var n = parseInt(value2, 10);
          if (!Number.isNaN(n))
            cookie.maxAge = n;
        } else if (key === "secure") {
          cookie.secure = true;
        } else if (key === "httponly") {
          cookie.httpOnly = true;
        } else if (key === "samesite") {
          cookie.sameSite = value2;
        } else if (key === "partitioned") {
          cookie.partitioned = true;
        } else if (key) {
          cookie[key] = value2;
        }
      });
      return cookie;
    }
    function parseNameValuePair(nameValuePairStr) {
      var name = "";
      var value = "";
      var nameValueArr = nameValuePairStr.split("=");
      if (nameValueArr.length > 1) {
        name = nameValueArr.shift();
        value = nameValueArr.join("=");
      } else {
        value = nameValuePairStr;
      }
      return { name, value };
    }
    function parseSetCookie(input, options) {
      options = options ? Object.assign({}, defaultParseOptions, options) : defaultParseOptions;
      if (!input) {
        if (!options.map) {
          return [];
        } else {
          return createNullObj();
        }
      }
      if (input.headers) {
        if (typeof input.headers.getSetCookie === "function") {
          input = input.headers.getSetCookie();
        } else if (input.headers["set-cookie"]) {
          input = input.headers["set-cookie"];
        } else {
          var sch = input.headers[Object.keys(input.headers).find(function(key) {
            return key.toLowerCase() === "set-cookie";
          })];
          if (!sch && input.headers.cookie && !options.silent) {
            console.warn(
              "Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning."
            );
          }
          input = sch;
        }
      }
      var split = options.split;
      var isArray = Array.isArray(input);
      if (split === "auto") {
        split = !isArray;
      }
      if (!isArray) {
        input = [input];
      }
      input = input.filter(isNonEmptyString);
      if (split) {
        input = input.map(splitCookiesString).flat();
      }
      if (!options.map) {
        return input.map(function(str) {
          return parseString(str, options);
        }).filter(Boolean);
      } else {
        var cookies = createNullObj();
        return input.reduce(function(cookies2, str) {
          var cookie = parseString(str, options);
          if (cookie && !isForbiddenKey(cookie.name)) {
            cookies2[cookie.name] = cookie;
          }
          return cookies2;
        }, cookies);
      }
    }
    function splitCookiesString(cookiesString) {
      if (Array.isArray(cookiesString)) {
        return cookiesString;
      }
      if (typeof cookiesString !== "string") {
        return [];
      }
      var cookiesStrings = [];
      var pos = 0;
      var start;
      var ch;
      var lastComma;
      var nextStart;
      var cookiesSeparatorFound;
      function skipWhitespace() {
        while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) {
          pos += 1;
        }
        return pos < cookiesString.length;
      }
      function notSpecialChar() {
        ch = cookiesString.charAt(pos);
        return ch !== "=" && ch !== ";" && ch !== ",";
      }
      while (pos < cookiesString.length) {
        start = pos;
        cookiesSeparatorFound = false;
        while (skipWhitespace()) {
          ch = cookiesString.charAt(pos);
          if (ch === ",") {
            lastComma = pos;
            pos += 1;
            skipWhitespace();
            nextStart = pos;
            while (pos < cookiesString.length && notSpecialChar()) {
              pos += 1;
            }
            if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
              cookiesSeparatorFound = true;
              pos = nextStart;
              cookiesStrings.push(cookiesString.substring(start, lastComma));
              start = pos;
            } else {
              pos = lastComma + 1;
            }
          } else {
            pos += 1;
          }
        }
        if (!cookiesSeparatorFound || pos >= cookiesString.length) {
          cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
        }
      }
      return cookiesStrings;
    }
    parseSetCookie.parseSetCookie = parseSetCookie;
    parseSetCookie.parse = parseSetCookie;
    parseSetCookie.parseString = parseString;
    parseSetCookie.splitCookiesString = splitCookiesString;
    module.exports = parseSetCookie;
  }
});

// ../../backend/lib/pacwebClient.js
var require_pacwebClient = __commonJS({
  "../../backend/lib/pacwebClient.js"(exports, module) {
    var crypto = __require("crypto");
    var { parseSetCookie } = require_set_cookie();
    var BASE = "https://appsnv.undergroundservicealert.org/posr/pacweb";
    var LOGIN_URL = `${BASE}/Account/Login`;
    var DEFAULT_RETURN_PATH = "/posr/pacweb/jobs/DashboardMain";
    var API_USER_CONTEXT = `${BASE}/PlanAccessCentre/api/jobs/GetUserContext`;
    var API_ENQUIRY_SUBSET = `${BASE}/PlanAccessCentre/api/jobs/GetEnquiryBySubset`;
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    function getPacSearchDateOption() {
      const raw = String(process.env.PAC_SEARCH_DATE_OPTION || "").trim().toLowerCase();
      if (raw === "legalstart")
        return "legalstart";
      return "createdon";
    }
    function resolveSearchDateOption(explicit) {
      const e = explicit != null ? String(explicit).trim().toLowerCase() : "";
      if (e === "legalstart" || e === "createdon")
        return e;
      return getPacSearchDateOption();
    }
    function buildMultipartBody(pairs, boundary) {
      const chunks = [];
      for (const [name, value] of pairs) {
        chunks.push(
          `--${boundary}\r
Content-Disposition: form-data; name="${name}"\r
\r
${value}\r
`
        );
      }
      chunks.push(`--${boundary}--\r
`);
      return Buffer.from(chunks.join(""), "utf8");
    }
    function getRawSetCookieList(response) {
      if (!response || !response.headers || typeof response.headers.raw !== "function") {
        return null;
      }
      const raw = response.headers.raw();
      if (!raw)
        return null;
      const key = Object.keys(raw).find((k) => k.toLowerCase() === "set-cookie");
      if (!key || !raw[key] || !raw[key].length)
        return null;
      return raw[key];
    }
    var CookieJar = class {
      constructor() {
        this.map = {};
      }
      addFromResponse(response) {
        const list = getRawSetCookieList(response);
        if (!list)
          return;
        const cookies = parseSetCookie(list, { decodeValues: false });
        for (const c of cookies) {
          if (c && c.name)
            this.map[c.name] = c.value;
        }
      }
      header() {
        return Object.entries(this.map).map(([k, v]) => `${k}=${v}`).join("; ");
      }
    };
    function extractRequestVerificationToken(html) {
      const m = html.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/) || html.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/) || html.match(/__RequestVerificationToken["\s]+value="([^"]+)"/);
      return m ? m[1] : null;
    }
    function hiddenInputValue(html, name) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tag = html.match(new RegExp(`<input[^>]+name="${esc}"[^>]*>`, "i"));
      if (!tag)
        return "";
      const vm = tag[0].match(/\bvalue="([^"]*)"/i);
      return vm ? vm[1] : "";
    }
    async function readJsonOrThrow(res, label) {
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${label}: not JSON (${res.status}): ${text.slice(0, 400)}`);
      }
      if (!res.ok) {
        const msg = data && typeof data === "object" ? String(
          data.Message ?? data.message ?? data.error ?? data.title ?? text.slice(0, 400)
        ) : text.slice(0, 400);
        throw new Error(`${label} failed (${res.status}): ${msg}`);
      }
      return data;
    }
    function buildGetEnquiryBySubsetBody(fromDate, toDate, ctx, opts) {
      const isMyJobsView = Boolean(opts && opts.isMyJobsView === true);
      const pelican = ctx && ctx.PelicanId != null && String(ctx.PelicanId).trim() !== "" ? String(ctx.PelicanId) : "";
      const company = ctx && ctx.CompanyId != null && String(ctx.CompanyId).trim() !== "" ? String(ctx.CompanyId) : "";
      return {
        IsMyJobsView: isMyJobsView,
        AreClosedJobsIncluded: false,
        UtilityResponseCount: "",
        FromJobNumber: "",
        ToJobNumber: "",
        FromSequenceNumber: "",
        ToSequenceNumber: "",
        FromPercentComplete: "",
        ToPercentComplete: "",
        FromDateCreatedInput: fromDate,
        ToDateCreatedInput: toDate,
        HasExpiredPlans: false,
        HasPastCompletionDate: false,
        HasNoSpatialData: false,
        ShowClosedJobsOnly: false,
        PlansReceivedInput: "",
        BatchAction: "First",
        JobsTableLimit: 50,
        FirstBatchIndex: 0,
        LastBatchIndex: 49,
        JobSorting: "DateRequested",
        ActiveSortOrder: -1,
        IsOneCallPAC: false,
        SearchDateOption: resolveSearchDateOption(opts && opts.searchDateOption),
        FetchOffset: 0,
        Status: "",
        SearchKeyword: "",
        SelectedStatus: "",
        PelicanId: pelican,
        CompanyId: company
      };
    }
    async function pacwebEstablishSession(fetch, opts) {
      const username = String(opts.username || "").trim();
      const password = String(opts.password || "");
      if (!username || !password) {
        throw new Error("username and password are required");
      }
      const jar = new CookieJar();
      const returnPath = opts.returnPath && String(opts.returnPath).trim() || DEFAULT_RETURN_PATH;
      const loginGetUrl = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnPath)}`;
      const loginGet = await fetch(loginGetUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT
        }
      });
      if (!loginGet.ok) {
        throw new Error(`GET Login failed: ${loginGet.status}`);
      }
      jar.addFromResponse(loginGet);
      const loginHtml = await loginGet.text();
      const csrf = extractRequestVerificationToken(loginHtml);
      if (!csrf) {
        throw new Error("Could not find __RequestVerificationToken on PAC login page");
      }
      const returnUrlField = hiddenInputValue(loginHtml, "ReturnUrl") || returnPath;
      let screenH = hiddenInputValue(loginHtml, "ScreenHeight");
      let screenW = hiddenInputValue(loginHtml, "ScreenWidth");
      if (!screenH)
        screenH = "1039";
      if (!screenW)
        screenW = "1920";
      const boundary = "----NodeFormBoundary" + crypto.randomBytes(16).toString("hex");
      const postBody = buildMultipartBody(
        [
          ["ReturnUrl", returnUrlField],
          ["ScreenHeight", screenH],
          ["ScreenWidth", screenW],
          ["emailOrUserName", username],
          ["password", password],
          ["__RequestVerificationToken", csrf]
        ],
        boundary
      );
      const loginPageReferer = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnUrlField)}`;
      let res = await fetch(LOGIN_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          Origin: new URL(BASE).origin,
          Referer: loginPageReferer,
          Cookie: jar.header(),
          "User-Agent": USER_AGENT
        },
        body: postBody
      });
      let referer = loginPageReferer;
      for (let hop = 0; hop < 12 && res.status >= 300 && res.status < 400; hop++) {
        jar.addFromResponse(res);
        let loc = res.headers.get("location");
        if (!loc)
          break;
        if (loc.startsWith("/"))
          loc = `${new URL(BASE).origin}${loc}`;
        res = await fetch(loc, {
          redirect: "manual",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: jar.header(),
            Referer: referer,
            "User-Agent": USER_AGENT
          }
        });
        referer = loc;
      }
      jar.addFromResponse(res);
      if (res.status === 200) {
        const page = await res.text();
        if (/name="emailOrUserName"/i.test(page) && (/Account\/Login/i.test(page) || /\/Account\/Login/i.test(page))) {
          throw new Error(
            "PAC login failed: still on login page after POST (check credentials / CSRF / form fields)."
          );
        }
      }
      const dashWarm = await fetch(`${BASE}/jobs/DashboardMain`, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: jar.header(),
          Referer: `${BASE}/jobs/MainDashboard`,
          "User-Agent": USER_AGENT
        }
      });
      jar.addFromResponse(dashWarm);
      await dashWarm.text();
      const dashboardReferer = `${BASE}/jobs/DashboardMain`;
      return { jar, dashboardReferer };
    }
    async function pacwebGetContextAndJobs(fetch, jar, dashboardReferer, fromDate, toDate, subsetOpts) {
      const fromD = String(fromDate || "").trim() || "02 Mar 2026";
      const toD = String(toDate || "").trim() || "02 Apr 2026";
      const ctxRes = await fetch(API_USER_CONTEXT, {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=utf-8",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: jar.header(),
          Referer: dashboardReferer,
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      jar.addFromResponse(ctxRes);
      const context = await readJsonOrThrow(ctxRes, "GetUserContext");
      const enquiryBody = buildGetEnquiryBySubsetBody(fromD, toD, context, subsetOpts);
      const jobsRes = await fetch(API_ENQUIRY_SUBSET, {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: new URL(BASE).origin,
          Cookie: jar.header(),
          Referer: dashboardReferer,
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(enquiryBody)
      });
      jar.addFromResponse(jobsRes);
      const jobs = await readJsonOrThrow(jobsRes, "GetEnquiryBySubset");
      return { context, jobs };
    }
    async function pacwebListJobs(fetch, opts) {
      const username = String(opts.username || "").trim();
      const password = String(opts.password || "");
      if (!username || !password) {
        throw new Error("username and password are required");
      }
      const fromD = opts.fromDate || "02 Mar 2026";
      const toD = opts.toDate || "02 Apr 2026";
      const contextOnly = Boolean(opts.contextOnly);
      const { jar, dashboardReferer } = await pacwebEstablishSession(fetch, {
        username,
        password,
        returnPath: opts.returnPath
      });
      const ctxRes = await fetch(API_USER_CONTEXT, {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=utf-8",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: jar.header(),
          Referer: dashboardReferer,
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      jar.addFromResponse(ctxRes);
      const context = await readJsonOrThrow(ctxRes, "GetUserContext");
      if (contextOnly) {
        return { context };
      }
      const enquiryBody = buildGetEnquiryBySubsetBody(fromD, toD, context, {
        isMyJobsView: opts.isMyJobsView === true,
        searchDateOption: opts.searchDateOption
      });
      const jobsRes = await fetch(API_ENQUIRY_SUBSET, {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: new URL(BASE).origin,
          Cookie: jar.header(),
          Referer: dashboardReferer,
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(enquiryBody)
      });
      jar.addFromResponse(jobsRes);
      const jobs = await readJsonOrThrow(jobsRes, "GetEnquiryBySubset");
      return { context, jobs };
    }
    module.exports = {
      pacwebListJobs,
      pacwebEstablishSession,
      pacwebGetContextAndJobs,
      /** For tests / session reuse: `Object.assign(new CookieJar().map, stored)` */
      CookieJar
    };
  }
});
export default require_pacwebClient();
