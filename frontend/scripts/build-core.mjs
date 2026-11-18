#!/usr/bin/env node
/** Core product frontend build — same-origin API via config-override.core.js */
process.env.CONFIG_OVERRIDE_REL = 'js/config-override.core.js';
await import('../build.mjs');