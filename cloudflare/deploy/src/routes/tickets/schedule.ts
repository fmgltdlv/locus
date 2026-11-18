import { getEnv } from '../../envContext.js';
import { runPacwebPollCore } from './pollRoutes.js';

export async function runScheduledUsanFullSync() {
  const env = getEnv();
  const orgId = parseInt(String(env.USAN_SCHEDULE_ORG_ID || '0'), 10);
  const userId = parseInt(String(env.USAN_SCHEDULE_USER_ID || '1'), 10);
  if (!orgId) {
    console.warn('[usan-schedule] USAN_SCHEDULE_ORG_ID not set; skipping nightly USAN/nGen list sync');
    return { kind: 'skip', reason: 'no_org' };
  }
  const fakeReq = {
    user: { id: userId, role: 'dev', organizationId: orgId, adminOrganizationIds: [] },
    body: { organizationId: orgId, fullSync: true },
  };
  return runPacwebPollCore(fakeReq, {});
}
