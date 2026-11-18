import { buildExpressReq } from "../expressCompat.js";

/** Parity with backend/server.js inline POSR + map proxy (mounted on same /api/tickets prefix). */
export const POSR_API_BASE =
    "https://appsnv.undergroundservicealert.org/posr/searchtool/PositiveResponse/GetJobsListForTable?format=json&ticketNumber=";
export const MAP_URL_BASE =
    "https://onecallnv.undergroundservicealert.org/ngen.web/map/index?RequestNumber=";
const POSR_SEARCH_TOOL_BASE = "https://appsnv.undergroundservicealert.org/posr/searchtool/";

/** When `1`, explicit public POSR/map **import** is allowed (separate from nGen refresh; no cross-fallback). */
export function isPosrStackEnabled() {
    return String(process.env.ENABLE_POSR_STACK || "").trim() === "1";
}

export function registerTicketProxyRoutes(tickets) {
    tickets.get("/:ticketNumber/posr", async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes");
        const ticketNumber = req.params.ticketNumber;
        try {
            const possibleUrls = [
                `${POSR_SEARCH_TOOL_BASE}`,
                `${POSR_SEARCH_TOOL_BASE}PosrTicketSearch/`,
                `${POSR_SEARCH_TOOL_BASE}PosrTicketSearch`,
                "https://appsnv.undergroundservicealert.org/posr/searchtool",
            ];
            let pageResponse = null;
            let searchPageUrl = null;
            let cookies = "";
            for (const url of possibleUrls) {
                try {
                    pageResponse = await fetch(url, {
                        method: "GET",
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "Accept-Language": "en-US,en;q=0.5",
                        },
                        redirect: "follow",
                    });
                    if (pageResponse.ok) {
                        searchPageUrl = url;
                        cookies = pageResponse.headers.get("set-cookie") || "";
                        break;
                    }
                } catch {
                    continue;
                }
            }
            if (!pageResponse) {
                return res.status(502).json({ error: "Could not load POSR search page" });
            }
            const searchPageHtml = await pageResponse.text();
            void searchPageHtml;
            const posrApiUrl = `${POSR_API_BASE}${ticketNumber}`;
            await fetch(posrApiUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            });
            const jobsListUrl = `${POSR_SEARCH_TOOL_BASE}PositiveResponse/GetJobsListForTable?format=json&ticketNumber=${ticketNumber}`;
            await fetch(jobsListUrl, {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    Accept: "application/json, text/plain, */*",
                    Referer: searchPageUrl || POSR_SEARCH_TOOL_BASE,
                    Cookie: cookies,
                },
            });
            const formData = new URLSearchParams();
            formData.append("ticketNumber", ticketNumber);
            const postUrl = searchPageUrl || POSR_SEARCH_TOOL_BASE;
            const postResponse = await fetch(postUrl, {
                method: "POST",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    Referer: postUrl,
                    Cookie: cookies,
                    Origin: POSR_SEARCH_TOOL_BASE.replace(/\/$/, ""),
                },
                body: formData.toString(),
                redirect: "follow",
            });
            if (postResponse.ok) {
                const html = await postResponse.text();
                if (
                    html.includes(ticketNumber) &&
                    (html.includes("Expiration Date") || html.includes('data-role="address"'))
                ) {
                    return res.json({ html });
                }
            }
            return res.status(500).json({
                error:
                    "Could not find ticket data. Tried multiple approaches. Search page HTML available but ticket data not found.",
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return res.status(500).json({ error: msg });
        }
    });

    tickets.get("/:ticketBase/map", async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes");
        const ticketBase = req.params.ticketBase;
        const full =
            (req.query.requestNumber && String(req.query.requestNumber).trim()) || `${ticketBase}-000`;
        try {
            const url = `${MAP_URL_BASE}${encodeURIComponent(full)}`;
            const response = await fetch(url, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            });
            if (!response.ok) {
                return res.status(502).json({ error: `Failed to fetch map page: ${response.status}` });
            }
            const html = await response.text();
            return res.json({ html });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return res.status(500).json({ error: msg });
        }
    });
}
