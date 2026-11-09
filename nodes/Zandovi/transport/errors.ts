import type { IDataObject, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { INVALID_API_KEY_MESSAGE } from '../../../credentials/ZandoviApi.credentials';

export const TIMEOUT_MESSAGE = 'Zandovi did not respond within 120 s';
export const RATE_LIMIT_MESSAGE = 'Zandovi rate limit reached; retry later';
export const IN_PROGRESS_MESSAGE = 'A previous attempt of this render is still running';
export const REDIRECT_MESSAGE =
	'Zandovi answered with a redirect, which the node does not follow; check the Base URL of the credential';
export const UPLOAD_HINT = 'Upload it first with Image → Upload';
export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
	'This Idempotency Key was already used with different inputs';

/** What an item's error output and a thrown error carry. */
export interface ZandoviFailure {
	message: string;
	status: number | null;
	code: string | null;
}

/** The RFC 9457 problem body the public API answers errors with; every field is optional. */
export interface Problem {
	code?: string;
	detail?: string;
	details?: unknown;
	errors?: unknown;
	violations?: unknown;
}

/** Names the request in error messages. */
export interface RequestLabels {
	/** The thing a 404 is about: `Template`, `Batch job` or `Image`. */
	resource: string;
	/** The operation a missing scope blocks, for example `Template → Generate`. */
	operation: string;
}

export function parseProblem(body: unknown): Problem {
	let value = body;
	if (Buffer.isBuffer(value)) value = value.toString('utf8');
	else if (value instanceof ArrayBuffer) value = Buffer.from(value).toString('utf8');
	if (typeof value === 'string') {
		const text = value.trim();
		try {
			value = JSON.parse(text);
		} catch {
			return text ? { detail: text } : {};
		}
	}
	return value !== null && typeof value === 'object' ? (value as Problem) : {};
}

export function header(headers: IDataObject, name: string): string | undefined {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	const value = key === undefined ? undefined : headers[key];
	return value === undefined || value === null ? undefined : String(value);
}

/** `Retry-After` in seconds, from either form the header allows; undefined when absent. */
export function retryAfterSeconds(headers: IDataObject): number | undefined {
	const value = header(headers, 'retry-after');
	if (value === undefined) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export function isQuotaExhausted(problem: Problem): boolean {
	return (
		problem.code === 'QUOTA_EXCEEDED' ||
		(problem.code === 'BATCH_RATE_LIMIT_EXCEEDED' && /monthly .*quota/i.test(problem.detail ?? ''))
	);
}

function quotaResetDate(headers: IDataObject): string {
	const reset = Date.parse(header(headers, 'x-quota-reset') ?? '');
	if (!Number.isNaN(reset)) return new Date(reset).toISOString().slice(0, 10);
	const seconds = retryAfterSeconds(headers);
	if (seconds !== undefined)
		return new Date(Date.now() + seconds * 1000).toISOString().slice(0, 10);
	return 'the 1st of next month';
}

/** Each entry of the problem's lists, naming its field or variable. */
function listedErrors(problem: Problem): string[] {
	const details = problem.details as IDataObject | undefined;
	const lists = [problem.errors, problem.details, problem.violations, details?.errors];
	const listed = lists.filter(Array.isArray).flatMap((list: unknown[]) =>
		list.map((entry) => {
			if (entry === null || typeof entry !== 'object') return String(entry);
			const item = entry as IDataObject;
			const subject = item.field ?? item.variable ?? item.path ?? item.name;
			const message = item.message ?? item.reason ?? item.code ?? JSON.stringify(item);
			return subject === undefined ? String(message) : `${String(subject)}: ${String(message)}`;
		}),
	);
	const nested = details?.errors;
	if (details && nested && typeof nested === 'object' && !Array.isArray(nested)) {
		// Batch validation sends `details` as { itemIndex, templateName, errors: { name: reason } }
		// for the first row that fails; the row is 1-based here, like the input items in n8n.
		const row = typeof details.itemIndex === 'number' ? `row ${details.itemIndex + 1}, ` : '';
		for (const [name, reason] of Object.entries(nested as IDataObject))
			if (typeof reason === 'string') listed.push(`${row}${name}: ${reason}`);
	} else if (details && !Array.isArray(details) && !Array.isArray(details.errors)) {
		// Variable validation sends `details` as a map of variable name to reason.
		for (const [name, reason] of Object.entries(details))
			if (typeof reason === 'string') listed.push(`${name}: ${reason}`);
	}
	return listed;
}

/** The message for an error response the request layer does not retry, per AC2.9. */
export function describeFailure(
	status: number,
	problem: Problem,
	headers: IDataObject,
	labels: RequestLabels,
): ZandoviFailure {
	const code = problem.code ?? null;
	const detail = problem.detail ?? `Zandovi answered with status ${status}`;
	const failure = (message: string): ZandoviFailure => ({ message, status, code });

	if (status >= 500) {
		return failure(`Zandovi service error (${status}); retry later`);
	}
	switch (status) {
		case 400:
			// Some validation responses already spell the listed errors out in `detail`.
			return failure(
				[detail, ...listedErrors(problem).filter((entry) => !detail.includes(entry))].join('; '),
			);
		case 401:
			return failure(INVALID_API_KEY_MESSAGE);
		case 403:
			if (code === 'INSUFFICIENT_SCOPE') {
				const scope = (problem.details as IDataObject | undefined)?.requiredScope ?? 'required';
				return failure(
					`This API key lacks the \`${String(scope)}\` scope needed for ${labels.operation}; create a key that has it`,
				);
			}
			return failure(detail);
		case 404:
			return failure(`${labels.resource} not found, or not visible to this API key's account`);
		case 409:
			return failure(code === 'IDEMPOTENCY_IN_PROGRESS' ? IN_PROGRESS_MESSAGE : detail);
		case 422:
			if (code === 'IDEMPOTENCY_KEY_REUSED') return failure(IDEMPOTENCY_KEY_REUSED_MESSAGE);
			if (code === 'IMAGE_VARIABLE_UNREACHABLE') {
				return failure(`${detail.replace(/\.?$/, '.')} ${UPLOAD_HINT}`);
			}
			return failure(detail);
		case 429:
			if (isQuotaExhausted(problem)) {
				return failure(
					`Monthly render quota used up; it resets on ${quotaResetDate(headers)}. Upgrade at app.zandovi.com/plans.`,
				);
			}
			return failure(code === 'RATE_LIMIT_EXCEEDED' ? RATE_LIMIT_MESSAGE : detail);
		default:
			return failure(detail);
	}
}

/**
 * A NodeApiError built only from the failure, never from the request or the raw response,
 * so the API key the credential added cannot reach the message, description or cause (AC2.11).
 */
export function zandoviError(node: INode, failure: ZandoviFailure): NodeApiError {
	const errorResponse: JsonObject = { status: failure.status, code: failure.code };
	const error = new NodeApiError(node, errorResponse, {
		message: failure.message,
		httpCode: failure.status === null ? undefined : String(failure.status),
	});
	// NodeApiError swaps any message whose upper-cased text merely contains a Node error code for
	// a generic one: "reuseExisting" holds EEXIST and became "The file or directory already
	// exists". The failure's message is always the node's own, so it is put back.
	if (error.message !== failure.message) {
		error.message = failure.message;
		error.messages = error.messages.filter((message) => message !== failure.message);
	}
	return error;
}

const TIMEOUT_CODES = ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'];

/** Turns an error thrown by the HTTP helper (no response at all) into a ZandoviFailure. */
export function transportFailure(error: unknown): ZandoviFailure {
	const chain: IDataObject[] = [];
	for (let current = error as IDataObject | undefined; current && chain.length < 5; ) {
		chain.push(current);
		current = (current.cause ?? undefined) as IDataObject | undefined;
	}
	const timedOut = chain.some(
		(entry) =>
			TIMEOUT_CODES.includes(String(entry.code)) || /timeout/i.test(String(entry.message ?? '')),
	);
	if (timedOut) return { message: TIMEOUT_MESSAGE, status: null, code: 'TIMEOUT' };
	// Only a system error code (ECONNREFUSED, ENOTFOUND, …) is shown: the raw message of an
	// unknown error could carry request details, the API key among them.
	const code = chain
		.map((entry) => entry.code)
		.find((value): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value));
	return {
		message: `Could not reach Zandovi (${code ?? 'network error'})`,
		status: null,
		code: code ?? 'NETWORK_ERROR',
	};
}

/** The failure an error carries, for Continue On Fail output. */
export function failureOf(error: Error): ZandoviFailure {
	const response = (error as NodeApiError).errorResponse;
	if (response && 'status' in response && 'code' in response) {
		return {
			message: error.message,
			status: (response.status as number | null) ?? null,
			code: (response.code as string | null) ?? null,
		};
	}
	return { message: error.message, status: null, code: null };
}
