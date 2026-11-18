# Error Codes

Customer-facing errors should be short, actionable, and paired with a stable code. Internal details are logged to `application_error_incidents` and visible to developers in Admin -> Errors.

| Code | Customer message | Internal meaning | Typical remediation |
| --- | --- | --- | --- |
| `APP_UNEXPECTED` | Something went wrong. Please try again. If it continues, contact support. | Unhandled or uncategorized server failure. | Check Admin -> Errors for the support ID, route, stack/detail, and recent deploy/migration changes. |
| `APP_BAD_REQUEST` | We could not complete that request. Please check the information and try again. | Generic validation failure. | Confirm submitted fields and add a more specific code if this becomes common. |
| `APP_FORBIDDEN` | You do not have permission to do that. | User lacks the required role or organization access. | Check user role, organization membership, and route authorization. |
| `APP_NOT_FOUND` | We could not find the requested item. | Requested record or route target was not found. | Confirm the ID, organization scope, and whether the item was deleted. |
| `EXTERNAL_SYNC_FAILED` | External list sync could not be completed. Please try again. | External sync failed after starting. | Review incident detail, provider availability, credentials, and nGen/PAC request failures. |
| `EXTERNAL_SYNC_ORG_REQUIRED` | Please select an organization before running external sync. | Full sync was requested without an organization ID. | Select one organization in Admin before running sync. |
| `NGEN_MASTER_ACCOUNT_MISSING` | No master account in this organization. Please add a master account. | Per-organization external sync needs a master provider account with a stored password. | Add or update the organization's master provider account. |
| `NGEN_POLL_CREDENTIALS_MISSING` | External sync is not ready for this organization. Please check the master account. | Credential validation passed or was bypassed, but credentials could not be loaded for the poll. | Verify the account row, encrypted password, and credential mode. |
| `NGEN_SERVICE_ACCOUNT_MISSING` | External sync is not configured yet. Please contact support. | Global service credentials are missing. | Configure Worker secrets or switch to per-organization credentials. |
| `NGEN_HISTORY_CREDENTIALS_MISSING` | Ticket history is unavailable right now. Please contact support. | nGen notification history needs service credentials that are not available. | Configure Worker credentials and retry the ticket history refresh. |
| `PAC_ACCOUNT_LOGIN_FAILED` | We could not verify this provider account. Please check the account details and try again. | Provider login/session establishment failed. | Confirm provider credentials and inspect the incident for upstream response details. |

## Support Workflow

1. Ask the customer for the displayed code and support ID if one is shown.
2. Open Admin -> Errors as a developer.
3. Search or scan for the support ID, then inspect the route, internal message, detail, user, and organization.
4. Acknowledge the incident once it has been triaged. Delete it when it is no longer useful.
