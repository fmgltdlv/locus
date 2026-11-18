import { Hono } from "hono";
import { authMiddleware } from "../auth.js";
import {
  expressReqResMiddleware,
  jsonBodyMiddleware,
  ResShim,
} from "../expressCompat.js";
import type { Env } from "../types.js";
import type { Context, Next } from "hono";
import { registerDataGeospatialRoutes } from "./dataGeospatialRoutes.js";
import {
  registerDataMediaBinaryRoutes,
  registerDataMediaUploadListRoutes,
  registerDataMediaAnnotationRoutes,
  registerDataMediaCrudRoutes,
  registerDataMediaPublicRoutes,
} from "./dataMediaRoutes.js";
import { registerDataPhotoMapRoutes } from "./dataPhotoMapRoutes.js";
import {
  registerDataMapWorkspaceRoutes,
  registerDataMapWorkspaceLayerPublicRoutes,
} from "./dataMapWorkspaceRoutes.js";
import { registerDataAerialRoutes } from "./dataAerialRoutes.js";
import { registerDataReportedEventsRoutes } from "./dataReportedEventsRoutes.js";

const data = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;

data.use("*", jsonBodyMiddleware);
/** Allow ?token= on media file/thumbnail without JWT; all other routes require auth */
data.use("*", async (c: Context, next: Next) => {
  const p = c.req.path;
  const isMediaBinary =
    p.includes("/media/") && (p.endsWith("/file") || p.endsWith("/thumbnail"));
  if (isMediaBinary && c.req.query("token")) {
    return next();
  }
  return authMiddleware(c, next);
});

/** Binary media (native Response; must run before expressReqResMiddleware) */
registerDataMediaBinaryRoutes(data);

data.use("*", expressReqResMiddleware);

/** Preserve original Express-compat register order */
registerDataGeospatialRoutes(data);
registerDataMediaUploadListRoutes(data);
registerDataPhotoMapRoutes(data);
registerDataMediaAnnotationRoutes(data);
registerDataMapWorkspaceRoutes(data);
registerDataAerialRoutes(data);
registerDataMediaCrudRoutes(data);
registerDataMediaPublicRoutes(data);
registerDataMapWorkspaceLayerPublicRoutes(data);
registerDataReportedEventsRoutes(data);

export { data };
