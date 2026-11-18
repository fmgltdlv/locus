import { Hono } from 'hono';
import type { Env } from '../../types.js';
import type { ResShim } from '../../expressCompat.js';
import { authMiddleware } from '../../auth.js';
import { expressReqResMiddleware, jsonBodyMiddleware } from '../../expressCompat.js';
import { registerTicketProxyRoutes } from '../ticketProxyRoutes.js';
import { registerTicketsPollRoutes } from './pollRoutes.js';
import { registerTicketsRefreshRoutes } from './refresh.js';
import { registerTicketsRenewalAndWriteRoutes } from './renewalAndWrites.js';
import { registerTicketsListRoutes } from './listRoutes.js';
import { registerTicketsHubQueryRoutes } from './hubQueries.js';
import { registerTicketsImportQueueRoutes } from './importQueue.js';
import { registerTicketsSubmitJobRoutes } from './submitJobs.js';
import { registerJobProjectRoutes } from './jobProjectRoutes.js';
import { registerTicketsDetailRoutes } from './detailRoutes.js';
import { registerTicketsAnalyticsRoutes } from './analyticsRoutes.js';

const tickets = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
tickets.use('*', jsonBodyMiddleware);
tickets.use('*', authMiddleware);
tickets.use('*', expressReqResMiddleware);

registerTicketProxyRoutes(tickets);
registerTicketsPollRoutes(tickets);
registerTicketsRefreshRoutes(tickets);
registerTicketsRenewalAndWriteRoutes(tickets);
registerTicketsListRoutes(tickets);
registerTicketsHubQueryRoutes(tickets);
registerTicketsImportQueueRoutes(tickets);
registerTicketsSubmitJobRoutes(tickets);
registerJobProjectRoutes(tickets);
registerTicketsAnalyticsRoutes(tickets);
registerTicketsDetailRoutes(tickets);

export { tickets };
export { runPacwebPollCore } from './pollRoutes.js';
export { runScheduledUsanFullSync } from './schedule.js';
