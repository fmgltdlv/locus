export const ERROR_CATALOG: Record<string, { status: number; message: string }>;
export function createAppError(code: string, options?: Record<string, unknown>): Error & Record<string, unknown>;
export function isAppError(err: unknown): boolean;
export function appErrorFromUnknown(err: unknown, fallbackCode?: string): Error & Record<string, unknown>;
export function logErrorIncident(db: unknown, err: unknown, context?: Record<string, unknown>): Promise<number | null>;
export function errorResponseBody(err: unknown): Record<string, unknown>;
export function sendAppError(res: unknown, db: unknown, err: unknown, context?: Record<string, unknown>): Promise<unknown>;
export function honoAppErrorResponse(c: unknown, db: unknown, err: unknown, context?: Record<string, unknown>): Promise<Response>;
