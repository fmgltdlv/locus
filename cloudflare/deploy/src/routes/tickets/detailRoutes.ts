// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import type { TicketsApp } from './types.js';
import { registerDetailNgenRoutes } from './detailNgenRoutes.js';
import { registerDetailViewLogRoutes } from './detailViewLogRoutes.js';
import { registerDetailNotesRoutes } from './detailNotesRoutes.js';
import { registerDetailProjectsComplianceRoutes } from './detailProjectsComplianceRoutes.js';
import { registerDetailCorePatchRoutes, registerDetailCoreTerminalRoutes } from './detailCoreRoutes.js';
import { registerDetailWorkflowRoutes } from './detailWorkflowRoutes.js';
/** Preserve original handler order: specific paths → PATCH → workflow → db-detail/GET/DELETE. */
export function registerTicketsDetailRoutes(tickets: TicketsApp) {
    registerDetailNgenRoutes(tickets);
    registerDetailViewLogRoutes(tickets);
    registerDetailNotesRoutes(tickets);
    registerDetailProjectsComplianceRoutes(tickets);
    registerDetailCorePatchRoutes(tickets);
    registerDetailWorkflowRoutes(tickets);
    registerDetailCoreTerminalRoutes(tickets);
}
