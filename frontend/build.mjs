import { readdir, mkdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { minify } from 'html-minifier-terser';
import { getManifest } from 'workbox-build';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const OUT = join(SRC, (process.env.FRONTEND_BUILD_OUTDIR || 'dist').trim() || 'dist');

function configOverrideRel() {
  return (process.env.CONFIG_OVERRIDE_REL || 'js/config-override.js').trim();
}

function isCoreFrontendBuild() {
  return configOverrideRel().replace(/\\/g, '/').endsWith('config-override.core.js');
}

function withConfigOverride(relPaths) {
  const co = configOverrideRel();
  return relPaths.map((p) => (p === 'js/config-override.js' ? co : p));
}

/** Bundled scripts and stylesheets under dist/im/ (stable logical filenames; see writeDistHeaders). */
const IM = 'im';
const TMP = '.build-tmp';

/**
 * Index page: two bundles around PDF.js (see index.html). Config runs earlier in HTML,
 * before Leaflet. This chunk runs after proj4 CDN, before pdf.min.js.
 */
const JS_BUNDLE_INDEX_PRE_PDF = [
  'js/utils.js',
  'js/overlayScroll.js',
  'js/uiBackStack.js',
  'js/appDialogs.js',
  'js/i18n.js',
  'js/mapIcons.js',
  'js/parcelGeocode.js',
  'js/mapCountyCoverage.js',
  'js/map.js',
  'js/mapOverlayToggles.js',
  'js/passwordPolicy.js',
  'js/roles.js',
  'js/auth.js',
  'js/orgDataPermissions.js',
  'js/clientErrorReporter.js',
  'js/offline/offlineCacheTtl.js',
  'js/offline/offlineStore.js',
  'js/offline/connectivity.js',
  'js/offline/offlineUi.js',
  'js/offline/offlineTickets.js',
  'js/offline/offlinePhotos.js',
  'js/offline/offlineNotes.js',
  'js/offline/offlineSync.js',
  'js/offline/offlineUsanDocs.js',
  'js/offline/offline-module.js',
  'js/adminInboxBadge.js',
  'js/orgSelector.js',
  'js/usanOnboarding.js',
  'js/guidedTourSteps.js',
  'js/guidedTour.js',
  'js/mapCircleMenus.js',
  'js/mapTopLeftControls.js',
  'js/operator-response-code-catalog.js',
  'js/ui.js',
  'js/geocodeSearch.js',
  'js/userLocation.js',
  'js/icons.js',
  'js/utilityTypes.js',
  'js/featureTypeLibrary.js',
  'js/mapToolActions.js',
  'js/drawing.js',
  'js/mapToolsMobile.js',
  'js/annotationModal.js',
  'js/annotationStorage.js',
  'js/annotationRenderer.js',
  'js/mapProximityPick.js',
  'js/layerManager.js',
  'js/dataLayerPreview.js',
  'js/fileImport.js',
  'js/annotations.js',
  'js/measure.js',
  'js/photos/photos-core.js',
  'js/photos/photos-map-sync.js',
  'js/photos/photos-manage-data.js',
  'js/photos/photos-media-urls.js',
  'js/photos/photos-layer.js',
  'js/photos/photoTags.js',
  'js/photos/photoTagSuggest.js',
  'js/photos/photoCanvasUtils.js',
  'js/photos/photoMapItemUtils.js',
  'js/photos/photoMicromap.js',
  'js/photos/photoExifReadShim.js',
  'js/photos/photoExifWrite.js',
  'js/photos/heic2anyShim.js',
  'js/photos/inPageCameraLocation.js',
  'js/photos/photoStakeOverlay.js',
  'js/photos/photoStakeUtils.js',
  'js/photos/photoZipExpand.js',
  'js/photos/photos-upload-viewer.js',
  'js/photos/photoTicketAssociation.js',
  'js/photos/mapRecentPhotosPreference.js',
  'js/photos/photoMapLoader.js',
  'js/photos/photoClusterDrawer.js',
  'js/photos/photos-exports.js',
  'js/photos/photosBatchesPanel.js',
  'js/photos/photosGalleryDragSelect.js',
  'js/documents.js',
];

/** Runs after pdf.min.js and worker inline script. */
const JS_BUNDLE_INDEX_POST_PDF = [
  'js/ticketHub/ticketHubText.js',
  'js/pdfEditor.js',
  'js/map/mapAerialTileLayer.js',
  'js/aerialMaps.js',
  'js/aerialMapPanel.js',
  'js/tickets/operatorResponseCodes.js',
  'js/tickets/workflowAckCompliance.js',
  'js/tickets/ticket-status.js',
  'js/ticketImporter.js',
  'js/tickets/ticketCommencementDates.js',
  'js/tickets/jobComplianceDates.js',
  'js/newTicketPayload.js',
  'js/tickets/usanPayloadPreview.js',
  'js/tickets/digSiteLimits.js',
  'js/createTicketMapPolygon.js',
  'js/tickets/bulkSubmitProgress.js',
  'js/tickets/submitFailureMapPreview.js',
  'js/userActivity.js',
  'js/tickets/submitJobPoller.js',
  'js/tickets/createTicketAssessorOverlay.js',
  'js/tickets/createTicketWizardPresets.js',
  'js/ui/searchableSelect.js',
  'js/tickets/createTicketWizard.js',
  'js/mapContextualDrawStrip.js',
  'js/tickets/projectAssignmentIndex.js',
  'js/tickets/operatorResponseRevision.js',
  'js/tickets/tickets-core.js',
  'js/tickets/ticket-detail-tabs.js',
  'js/tickets/ticketNotes.js',
  'js/tickets/ticketJobCompliance.js',
  'js/tickets/ticketProjectMembership.js',
  'js/tickets/tickets-map.js',
  'js/tickets/renewalUxMockFlow.js',
  'js/tickets/fflateZipShim.js',
  'js/tickets/ticketDocumentPackFlow.js',
  'js/tickets/operatorResponseComments.js',
  'js/tickets/operatorResponseCards.js',
  'js/tickets/ngenProviderResponseHistory.js',
  'js/tickets/tickets-popup.js',
  'js/tickets/tickets-assignees.js',
  'js/tickets/tickets-popup-assignees.js',
  'js/tickets/tickets-list-importer.js',
  'js/tickets/tickets-org-cache.js',
  'js/tickets/tickets-load.js',
  'js/tickets/tickets-photo-views.js',
  'js/tickets/tickets-operations-photos.js',
  'js/tickets/tickets-workflow-ack.js',
  'js/tickets/tickets-expiring-exports.js',
  'js/ticketHubDisplayMap.js',
  'js/tickets/ngenHistoryTips.js',
  'js/ticketHub/ticket-hub-core.js',
  'js/ticketHub/ticket-hub-feed.js',
  'js/feedMapLayer.js',
  'js/tickets/ticketRenewalBulkFlow.js',
  'js/tickets/ticketBulkMapReview.js',
  'js/tickets/ticketRemarkFlow.js',
  'js/tickets/ticketRemarkBulkFlow.js',
  'js/tickets/ticketAmendmentFlow.js',
  'js/tickets/ticketCloneFlow.js',
  'js/tickets/ticketActionsMenu.js',
  'js/tickets/ticketOperatorSubmitShared.js',
  'js/tickets/ticketReportEventFlow.js',
  'js/tickets/ticketFollowUpFlow.js',
  'js/tickets/ticketDisputeFlow.js',
  'js/tickets/ticketNoResponseFlow.js',
  'js/ticketHub/ticket-hub-detail-renderers.js',
  'js/ticketHub/ticketHubColumnRegistry.js',
  'js/ticketHub/ticket-hub-actions.js',
  'js/ticketHub/ticket-hub-table-window.js',
  'js/ticketHub/ticket-hub-dock.js',
  'js/ticketHub/complianceHubProjectMapPick.js',
  'js/ticketHub/ticket-hub-compliance.js',
  'js/ticketHub/ticket-hub-analytics.js',
  'js/ticketHub/ticket-hub-bootstrap.js',
  'js/reportedEventsStore.js',
  'js/dataHubDraftBadge.js',
  'js/geoGpsAverage.js',
  'js/dirtReportPhotoGallery.js',
  'js/dirtReportExportShim.js',
  'js/dirtReport.js',
  'js/dataWindow.js',
  'js/dataSelection.js',
  'js/dataWindowGroups.js',
  'js/htmlEscape.js',
  'js/table/tableSorting.js',
  'js/table/tableUtils.js',
  'js/table/dataHubPagination.js',
  'js/table/tableFiltering.js',
  'js/table/dataHubFilters.js',
  'js/table/tablePhotoActions.js',
  'js/table/tableDocumentActions.js',
  'js/table/tableEventActions.js',
  'js/table/tableServiceRequestActions.js',
  'js/table/tableActions.js',
  'js/table/tableDelegation.js',
  'js/table/manageDataRowInfo.js',
  'js/table/renderers/annotationsRenderer.js',
  'js/table/renderers/photosRenderer.js',
  'js/table/renderers/documentsRenderer.js',
  'js/table/renderers/eventsRenderer.js',
  'js/table/renderers/layersRenderer.js',
  'js/table/renderers/aerialMapsRenderer.js',
  'js/table/tableQueries.js',
  'js/table/tableRenderer.js',
  'js/dataHubSeed.js',
  'js/dataExport.js',
  'js/data.js',
  'js/appResume.js',
  'app.js',
];

/** Local script order must match admin.html. */
const JS_BUNDLE_ADMIN = [
  'js/utils.js',
  'js/config-override.js',
  'js/config.js',
  'js/appDialogs.js',
  'js/i18n.js',
  'js/passwordPolicy.js',
  'js/roles.js',
  'js/auth.js',
  'js/orgDataPermissions.js',
  'js/clientErrorReporter.js',
  'js/userActivity.js',
  'js/utilityTypes.js',
  'js/featureTypeLibrary.js',
  'js/orgIconUtils.js',
  'js/admin/admin-shared.js',
  'js/admin/admin-service-requests-map.js',
  'js/tickets/operatorResponseCodes.js',
  'js/tickets/workflowAckCompliance.js',
  'js/admin/admin-core.js',
  'js/admin/admin-data.js',
  'js/admin/admin-operations.js',
  'js/admin/admin-organizations-users.js',
  'js/admin/admin-bootstrap.js',
];

/** Local script order must match login.html / signup.html. */
const JS_BUNDLE_LOGIN = [
  'js/config-override.js',
  'js/config.js',
  'js/appDialogs.js',
  'js/passwordPolicy.js',
  'js/roles.js',
  'js/auth.js',
  'js/orgDataPermissions.js',
  'js/clientErrorReporter.js',
  'js/signup.js',
];

/** Slim read-only project share page (share.html). */
const JS_BUNDLE_SHARE = [
  'js/config-override.js',
  'js/config.js',
  'js/clientErrorReporter.js',
  'js/utils.js',
  'js/mapIcons.js',
  'js/map/mapAerialTileLayer.js',
  'js/map/mapPhotoMarkers.js',
  'js/map/photoViewerReadOnly.js',
  'js/map/photoClusterListReadOnly.js',
  'js/share/operatorResponseStatus.js',
  'js/projectShareNvPublic.js',
  'js/shareLinkQrShim.js',
  'js/sharePageCaptureShim.js',
  'js/projectSharePage.js',
];

const CSS_ENTRIES = ['styles.css', 'admin.css', 'css/app-themes.css', 'css/auth-page.css', 'css/project-share-page.css', 'css/loading-indicators-demo.css'];

/** HTML `href` / `src` fragment → stable path under `im/<logical>.<ext>`. */
const CSS_HREF_TO_LOGICAL = {
  'styles.css': 'styles',
  'admin.css': 'admin',
  'css/app-themes.css': 'app-themes',
  'css/auth-page.css': 'auth-page',
  'css/project-share-page.css': 'project-share-page',
  'css/loading-indicators-demo.css': 'loading-indicators-demo',
};

const HTML_MINIFY = {
  caseSensitive: true,
  collapseBooleanAttributes: true,
  collapseWhitespace: true,
  conservativeCollapse: true,
  minifyCSS: true,
  minifyJS: {
    compress: { drop_console: true, dead_code: true },
    mangle: true,
  },
  removeComments: true,
  removeEmptyAttributes: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
};

/** HSTS max-age (seconds) for `dist/_headers` — one year. */
const HSTS_MAX_AGE_SECONDS = 31536000;

/**
 * Optional comma-separated deployment origins for CSP connect-src/img-src
 * (e.g. CSP_DEPLOYMENT_ORIGINS=https://api.example.com,https://app.example.com).
 */
const DEPLOYMENT_CSP_ORIGINS = String(process.env.CSP_DEPLOYMENT_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Content-Security-Policy for Pages `dist/_headers` (enforced as of step 11).
 * Manage Data table actions use delegated listeners (no inline handlers there).
 * `unsafe-inline` remains for index.html modals, column sort, PDF tools, and small boot scripts.
 */
function buildContentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://static.cloudflareinsights.com https://maps.googleapis.com https://maps.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com https://tiles.openfreemap.org data:",
    [
      "img-src 'self' data: blob:",
      ...DEPLOYMENT_CSP_ORIGINS,
      "https://api.mapbox.com",
      "https://tiles.openfreemap.org",
      "https://*.basemaps.cartocdn.com",
      "https://tile.openstreetmap.org",
      "https://*.tile.openstreetmap.org",
      // Clark County GISMO AssessorMap / AssessorAnno L.imageOverlay (create-ticket).
      "https://maps.clarkcountynv.gov",
      // USAN GeoServer parcels_nv WMS (create-ticket NV fallback).
      "https://usanmap.pcges.us",
      "https://storage.googleapis.com",
      "https://maps.googleapis.com",
      "https://maps.gstatic.com",
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      "https://cdnjs.cloudflare.com",
      "http://127.0.0.1:*",
      "http://localhost:*",
    ].join(' '),
    [
      "connect-src 'self'",
      "https://cloudflareinsights.com",
      ...DEPLOYMENT_CSP_ORIGINS,
      "https://api.mapbox.com",
      // Basemap tiles: SW fetch() is governed by connect-src (not img-src).
      "https://tiles.openfreemap.org",
      "https://*.basemaps.cartocdn.com",
      "https://tile.openstreetmap.org",
      "https://*.tile.openstreetmap.org",
      "https://maps.googleapis.com",
      "https://maps.gstatic.com",
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      // USAN GeoServer WMS tiles (SW fetch uses connect-src).
      "https://usanmap.pcges.us",
      // Clark address search is a browser fetch; Workers get an empty body from this host.
      "https://maps.clarkcountynv.gov",
      "https://unpkg.com",
      "https://cdnjs.cloudflare.com",
      "wss:",
      "http://127.0.0.1:*",
      "http://localhost:*",
    ].join(' '),
    "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    "frame-src 'self' blob: data:",
    "manifest-src 'self'",
  ].join('; ');
}

/** Global security headers applied to all paths via `/*` in dist/_headers. */
function buildGlobalSecurityHeaderLines() {
  return [
    `  Strict-Transport-Security: max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: DENY',
    `  Content-Security-Policy: ${buildContentSecurityPolicy()}`,
    '  Permissions-Policy: camera=(self), geolocation=(self), microphone=(), payment=(), usb=()',
  ];
}

/** Prevent SPA fallback to index.html for static asset paths (404 when missing, not HTML). */
function writeDistRoutes() {
  return JSON.stringify(
    {
      version: 1,
      include: ['/*'],
      exclude: [
        '/im/*',
        '/assets/*',
        '/js/*',
        '/data/*',
        '/manifest.webmanifest',
        '/sw.js',
        '/_headers',
        '/_redirects',
        '/index.html',
        '/login.html',
        '/admin.html',
        '/forgot-password.html',
        '/reset-password.html',
        '/signup.html',
        '/privacy-policy.html',
        '/share.html',
        '/loading-indicators.html',
        '/share/*',
      ],
    },
    null,
    2
  );
}

/** Missing hashed asset under /im/ → 404 (not index.html SPA fallback). See Cloudflare Pages not-found behavior. */
function writeIm404Html() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body>Not found</body></html>';
}

function writeDistHeaders() {
  return [
    '/*',
    ...buildGlobalSecurityHeaderLines(),
    '',
    '/im/*',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/config.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/config-override.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/pwa-register.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/auth-onecall-ui.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/auth-branding.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/mobilePinchZoomGuard.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/js/vendor/pdf.worker.min.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/manifest.webmanifest',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '  Content-Type: application/manifest+json',
    '',
    '/sw.js',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/index.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/login.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/forgot-password.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/reset-password.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/signup.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/privacy-policy.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/admin.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/share.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/loading-indicators.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/share',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/share/',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
  ].join('\n');
}

/** Raster PWA icons under assets/pwa (manifest + apple-touch-icon). */
async function writePwaRasterIcons(opts) {
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default;
  const svgPath = opts?.svgPath || join(SRC, 'assets', 'logo-mark.svg');
  const outDir = opts?.outDir || join(SRC, 'assets', 'pwa');
  const maskableRgb = opts?.maskableRgb || { r: 7, g: 48, b: 71 };
  await mkdir(outDir, { recursive: true });
  const svgBuf = await readFile(svgPath);
  await sharp(svgBuf).resize(192, 192).png().toFile(join(outDir, 'icon-192.png'));
  await sharp(svgBuf).resize(512, 512).png().toFile(join(outDir, 'icon-512.png'));
  const inner512 = await sharp(svgBuf).resize(412, 412).png().toBuffer();
  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: maskableRgb.r, g: maskableRgb.g, b: maskableRgb.b, alpha: 1 },
    },
  })
    .composite([{ input: inner512, gravity: 'centre' }])
    .png()
    .toFile(join(outDir, 'icon-maskable-512.png'));
}

async function copyDir(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  for (const ent of await readdir(srcDir, { withFileTypes: true })) {
    const from = join(srcDir, ent.name);
    const to = join(destDir, ent.name);
    if (ent.isDirectory()) {
      await copyDir(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

/** npm-backed entries are esbuild-bundled before concat (IIFE globals). */
const NPM_SHIM_BUNDLES = new Set([
  'js/tickets/fflateZipShim.js',
  'js/photos/photoExifReadShim.js',
  'js/photos/photoExifWrite.js',
  'js/photos/heic2anyShim.js',
  'js/shareLinkQrShim.js',
  'js/sharePageCaptureShim.js',
  'js/dirtReportExportShim.js',
]);

async function readBundleSource(rel) {
  const abs = join(SRC, rel);
  if (NPM_SHIM_BUNDLES.has(rel)) {
    const tmpFile = join(OUT, TMP, rel.replace(/[\\/]/g, '_').replace(/\.js$/, '') + '.bundle.js');
    await mkdir(dirname(tmpFile), { recursive: true });
    await build({
      entryPoints: [abs],
      outfile: tmpFile,
      bundle: true,
      minify: false,
      platform: 'browser',
      format: 'iife',
      logLevel: 'warning',
    });
    return readFile(tmpFile, 'utf8');
  }
  try {
    await stat(abs);
  } catch {
    throw new Error(`Bundle source missing: ${rel}`);
  }
  return readFile(abs, 'utf8');
}

async function concatBundleSources(relPaths) {
  const parts = [];
  for (const rel of relPaths) {
    parts.push(await readBundleSource(rel));
  }
  return parts.join('\n;\n');
}

/** When set, same bytes as `im/<logical>.<hash>.js` are also written here for serving `frontend/` directly. */
const LOGICAL_JS_TO_SRC_BUNDLE = {
  'app-index-pre-pdf': 'js/app-index.pre-pdf.bundle.js',
  'app-index-post-pdf': 'js/app-index.post-pdf.bundle.js',
  'app-admin': 'js/app-admin.bundle.js',
  'app-login': 'js/app-login.bundle.js',
  'app-share': 'js/app-share.bundle.js',
};

/**
 * Minify JS to a temp file, write stable `im/<logical>.js`, return public path (forward slashes).
 * Workbox precache uses file-content revision; URLs stay stable across deploys.
 * @param {boolean} [alsoWriteSrcBundle] - If true, also write `LOGICAL_JS_TO_SRC_BUNDLE[logicalName]` under `SRC/` (local dev).
 */
async function writeFingerprintedJsBundle(logicalName, relPaths, alsoWriteSrcBundle) {
  const contents = await concatBundleSources(relPaths);
  const tmpFile = join(OUT, TMP, `${logicalName}.js`);
  await mkdir(dirname(tmpFile), { recursive: true });
  await build({
    stdin: {
      contents,
      resolveDir: SRC,
      loader: 'js',
      sourcefile: 'concat-bundle.js',
    },
    outfile: tmpFile,
    bundle: false,
    minify: true,
    legalComments: 'none',
    drop: ['console', 'debugger'],
    platform: 'browser',
    logLevel: 'warning',
  });
  const buf = await readFile(tmpFile);
  const relUrl = `${IM}/${logicalName}.js`;
  await writeFile(join(OUT, relUrl), buf);
  if (alsoWriteSrcBundle) {
    const srcRel = LOGICAL_JS_TO_SRC_BUNDLE[logicalName];
    if (srcRel) {
      const srcAbs = join(SRC, srcRel);
      await mkdir(dirname(srcAbs), { recursive: true });
      await writeFile(srcAbs, buf);
    }
  }
  await rm(tmpFile, { force: true });
  return relUrl;
}

/** Written separately so index.html can load them before Leaflet / document.write loaders. */
async function writeEarlyIndexScripts() {
  const configOut = join(OUT, 'js/config-override.js');
  const otherEntryPoints = [
    join(SRC, 'js/config.js'),
    join(SRC, 'js/pwa-register.js'),
    join(SRC, 'js/mobilePinchZoomGuard.js'),
    join(SRC, 'js/auth-onecall-ui.js'),
    join(SRC, 'js/auth-branding.js'),
  ];
  const configSrc = join(SRC, configOverrideRel());
  for (const p of [configSrc, ...otherEntryPoints]) {
    try {
      await stat(p);
    } catch {
      throw new Error(`Missing ${p}`);
    }
  }
  await mkdir(dirname(configOut), { recursive: true });
  await build({
    entryPoints: [configSrc],
    outfile: configOut,
    bundle: false,
    minify: true,
    legalComments: 'none',
    drop: ['console', 'debugger'],
    platform: 'browser',
    logLevel: 'warning',
  });
  await build({
    entryPoints: otherEntryPoints,
    outbase: SRC,
    outdir: OUT,
    bundle: false,
    minify: true,
    legalComments: 'none',
    drop: ['console', 'debugger'],
    platform: 'browser',
    logLevel: 'warning',
  });
}

function expandUrlMapForHtml(urlMap) {
  const expanded = { ...urlMap };
  for (const [from, to] of Object.entries(urlMap)) {
    if (from.startsWith('/') || from.startsWith('http')) continue;
    const dest = to.startsWith('/') ? to : `/${to}`;
    expanded[`/${from}`] = dest;
  }
  return expanded;
}

function applyHtmlFingerprintMap(rawHtml, urlMap) {
  const keys = Object.keys(urlMap).sort((a, b) => b.length - a.length);
  let html = rawHtml;
  /** Placeholder pass prevents shorter keys (e.g. styles.css) rematching inside /im/styles.css. */
  const placeholders = [];
  keys.forEach((from, i) => {
    if (!html.includes(from)) return;
    const token = `\0FP${i}\0`;
    html = html.split(from).join(token);
    const to = urlMap[from];
    placeholders.push({
      token,
      to: to.startsWith('/') || to.startsWith('http') ? to : `/${to}`,
    });
  });
  for (const { token, to } of placeholders) {
    html = html.split(token).join(to);
  }
  return html;
}

async function emptyOutputDir(outDir) {
  await mkdir(outDir, { recursive: true });
  let ents;
  try {
    ents = await readdir(outDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    ents.map((e) => rm(join(outDir, e.name), { recursive: true, force: true })),
  );
}

async function main() {
  const writeSourceBundles = process.argv.includes('--write-source-bundles');

  await writePwaRasterIcons();

  await emptyOutputDir(OUT);
  await mkdir(join(OUT, IM), { recursive: true });

  await writeEarlyIndexScripts();

  const prePdf = await writeFingerprintedJsBundle('app-index-pre-pdf', JS_BUNDLE_INDEX_PRE_PDF, writeSourceBundles);
  const postPdf = await writeFingerprintedJsBundle('app-index-post-pdf', JS_BUNDLE_INDEX_POST_PDF, writeSourceBundles);
  const adminJs = await writeFingerprintedJsBundle('app-admin', withConfigOverride(JS_BUNDLE_ADMIN), writeSourceBundles);
  const loginJs = await writeFingerprintedJsBundle('app-login', withConfigOverride(JS_BUNDLE_LOGIN), writeSourceBundles);
  const shareJs = await writeFingerprintedJsBundle('app-share', withConfigOverride(JS_BUNDLE_SHARE), writeSourceBundles);

  await rm(join(OUT, TMP), { recursive: true, force: true }).catch(() => {});

  for (const r of CSS_ENTRIES) {
    const p = join(SRC, r);
    try {
      await stat(p);
    } catch {
      throw new Error(`Missing CSS: ${r}`);
    }
  }
  await build({
    entryPoints: CSS_ENTRIES.map((r) => join(SRC, r)),
    outbase: SRC,
    outdir: OUT,
    bundle: true,
    minify: true,
    loader: { '.css': 'css', '.jpg': 'file', '.jpeg': 'file', '.png': 'file', '.svg': 'file' },
    logLevel: 'warning',
  });

  const urlMap = {
    'js/app-index.pre-pdf.bundle.js': prePdf,
    'js/app-index.post-pdf.bundle.js': postPdf,
    'js/app-admin.bundle.js': adminJs,
    'js/app-login.bundle.js': loginJs,
    'js/app-share.bundle.js': shareJs,
  };

  for (const href of Object.keys(CSS_HREF_TO_LOGICAL)) {
    const outRel = href;
    const logical = CSS_HREF_TO_LOGICAL[href];
    const abs = join(OUT, outRel);
    const buf = await readFile(abs);
    const relUrl = `${IM}/${logical}.css`;
    await writeFile(join(OUT, relUrl), buf);
    await rm(abs, { force: true });
    urlMap[href] = relUrl;
  }

  try {
    await rm(join(OUT, 'css'), { recursive: true, force: true });
  } catch {
    //
  }

  const htmlUrlMap = expandUrlMapForHtml(urlMap);

  const coreBuild = isCoreFrontendBuild();
  for (const name of ['index.html', 'admin.html', 'login.html', 'forgot-password.html', 'reset-password.html', 'share.html', 'signup.html', 'privacy-policy.html', 'loading-indicators.html']) {
    const raw = await readFile(join(SRC, name), 'utf8');
    const withCoreFavicon = coreBuild
      ? raw.replace(/(href=["'](?:\/)?assets\/)logo-mark\.svg(["'])/g, '$1logo-mark-core.svg$2')
      : raw;
    const patched = applyHtmlFingerprintMap(withCoreFavicon, htmlUrlMap);
    const html = await minify(patched, {
      ...HTML_MINIFY,
      continueOnParseError: false,
    });
    await writeFile(join(OUT, name), html, 'utf8');
    if (name === 'share.html') {
      const shareDir = join(OUT, 'share');
      await mkdir(shareDir, { recursive: true });
      await writeFile(join(shareDir, 'index.html'), html, 'utf8');
      // Closest-directory 404 so /share/{id} can still resolve if SPA fallback races redirects.
      await writeFile(join(shareDir, '404.html'), html, 'utf8');
    }
  }

  let manifestJson = await readFile(join(SRC, 'manifest.webmanifest'), 'utf8');
  if (coreBuild) {
    const manifest = JSON.parse(manifestJson);
    manifest.theme_color = '#0b0d10';
    manifest.background_color = '#0b0d10';
    manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  await writeFile(join(OUT, 'manifest.webmanifest'), manifestJson, 'utf8');

  const dataPath = join(SRC, 'data');
  try {
    await stat(dataPath);
    await copyDir(dataPath, join(OUT, 'data'));
  } catch {
    // optional
  }

  const assetsPath = join(SRC, 'assets');
  try {
    await stat(assetsPath);
    await copyDir(assetsPath, join(OUT, 'assets'));
  } catch {
    // optional
  }

  if (coreBuild) {
    await writePwaRasterIcons({
      svgPath: join(SRC, 'assets', 'logo-mark-core.svg'),
      outDir: join(OUT, 'assets', 'pwa'),
      maskableRgb: { r: 11, g: 13, b: 16 },
    });
  }

  // PDF.js worker (same-origin) — mobile browsers often cannot load CDN workers.
  const pdfWorkerSrc = join(SRC, 'js', 'vendor', 'pdf.worker.min.js');
  const pdfWorkerOut = join(OUT, 'js', 'vendor', 'pdf.worker.min.js');
  try {
    await stat(pdfWorkerSrc);
    await mkdir(dirname(pdfWorkerOut), { recursive: true });
    await copyFile(pdfWorkerSrc, pdfWorkerOut);
  } catch {
    throw new Error(`Missing ${pdfWorkerSrc} — required for mobile PDF viewing`);
  }

  const extra = ['pages-deployment.example.json', '_redirects'];
  for (const f of extra) {
    try {
      await copyFile(join(SRC, f), join(OUT, f));
    } catch {
      // optional
    }
  }

  const { manifestEntries, warnings, size, count } = await getManifest({
    globDirectory: OUT,
    globPatterns: [
      'manifest.webmanifest',
      'index.html',
      'admin.html',
      'login.html',
      'forgot-password.html',
      'reset-password.html',
      'signup.html',
      'privacy-policy.html',
      'share.html',
      'share/index.html',
      'share/404.html',
      'loading-indicators.html',
      '_redirects',
      'js/pwa-register.js',
      'js/auth-onecall-ui.js',
      'js/auth-branding.js',
      'js/mobilePinchZoomGuard.js',
      'js/vendor/pdf.worker.min.js',
      'data/operator-response-code-catalog.json',
      'data/newTicketLookups.json',
      'data/newTicketLookupsShort.json',
      'data/newTicketLookupsEmergency.json',
      'im/*.js',
      'im/*.css',
      'js/config.js',
      'js/config-override.js',
      'assets/**/*.png',
      'assets/**/*.jpg',
      'assets/**/*.svg',
    ],
    globIgnores: ['**/pages-deployment.example.json', '**/sw.js'],
    maximumFileSizeToCacheInBytes: 35 * 1024 * 1024,
  });

  if (warnings?.length) {
    for (const w of warnings) console.warn('[workbox]', w);
  }

  const esbuildSw = await import('esbuild');
  await esbuildSw.build({
    entryPoints: [join(SRC, 'sw-src.js')],
    bundle: true,
    outfile: join(OUT, 'sw.js'),
    minify: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    legalComments: 'none',
    define: {
      __WB_MANIFEST_INJECT: JSON.stringify(manifestEntries),
    },
  });

  console.log(`[workbox] Precache ${count} entries (${size} bytes).`);

  await writeFile(join(OUT, '_headers'), writeDistHeaders(), 'utf8');
  await writeFile(join(OUT, '_routes.json'), writeDistRoutes(), 'utf8');
  await writeFile(
    join(OUT, '.assetsignore'),
    ['_routes.json', '_redirects', '_worker.js', '.assetsignore'].join('\n') + '\n',
    'utf8',
  );
  await mkdir(join(OUT, IM), { recursive: true });
  await writeFile(join(OUT, IM, '404.html'), writeIm404Html(), 'utf8');

  console.log(`[frontend build] Wrote ${OUT}: stable JS/CSS under ${IM}/, HTML + _headers + _routes.json + sw.js, js/config*.js.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
