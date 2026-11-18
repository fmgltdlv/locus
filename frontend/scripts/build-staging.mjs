#!/usr/bin/env node
/** Staging frontend build — uses js/config-override.staging.js for API origin. */
process.env.CONFIG_OVERRIDE_REL = 'js/config-override.staging.js';
await import('../build.mjs');
