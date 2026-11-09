import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
} from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { version as packageVersion } from '../../../package.json';
import type { RequestLabels } from './errors';
import {
	describeFailure,
	IN_PROGRESS_MESSAGE,
	parseProblem,
	REDIRECT_MESSAGE,
	RATE_LIMIT_MESSAGE,
	retryAfterSeconds,
	transportFailure,
	zandoviError,
} from './errors';

export const DEFAULT_BASE_URL = 'https://app.zandovi.com';
export const REQUEST_TIMEOUT_MS = 120_000;
export const RATE_LIMIT_MAX_RETRIES = 3;
export const RATE_LIMIT_MAX_WAIT_SECONDS = 30;
export const IN_PROGRESS_MAX_RETRIES = 5;
export const IN_PROGRESS_WAIT_MS = 2_000;
export const CANCELLED_MESSAGE = 'The execution was cancelled';
export const BASE_URL_MESSAGE =
	"The credential's Base URL must be an https:// address without a user name, password, query or fragment (http:// is accepted only for localhost)";

export interface ZandoviRequest extends RequestLabels {
	method: IHttpRequestMethods;
	/** Path under `<Base URL>/api/v1`, starting with `/`. */
	path: string;
	qs?: IDataObject;
	body?: IHttpRequestOptions['body'];
	headers?: IDataObject;
	/** Set for a binary response (`arraybuffer`); JSON otherwise. */
	encoding?: IHttpRequestOptions['encoding'];
}

export interface ZandoviResponse {
	statusCode: number;
	headers: IDataObject;
	body: unknown;
}

/** `zandovi-n8n/<package version>`, plus ` n8n/<n8n version>` when that version is known. */
export function userAgent(n8nVersion?: string): string {
	const agent = `zandovi-n8n/${packageVersion}`;
	return n8nVersion ? `${agent} n8n/${n8nVersion}` : agent;
}

/**
 * The Base URL without trailing slashes and without a trailing `/api/v1` segment (D17, D-T10.1);
 * a blank value falls back to the default. Any other path is kept. The credential test
 * expression applies the same steps.
 */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
	return (baseUrl || DEFAULT_BASE_URL)
		.replace(/\/+$/, '')
		.replace(/\/api\/v1$/i, '')
		.replace(/\/+$/, '');
}

export function apiUrl(baseUrl: string | undefined, path: string): string {
	return `${normalizeBaseUrl(baseUrl)}/api/v1${path}`;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether the Base URL may receive the API key: an https:// address, or http:// on a loopback
 * host for local development, with no user info, query or fragment.
 */
export function isAllowedBaseUrl(baseUrl: string | undefined): boolean {
	let url: URL;
	try {
		url = new URL(normalizeBaseUrl(baseUrl));
	} catch {
		return false;
	}
	if (url.username || url.password || url.search || url.hash) return false;
	if (url.protocol === 'https:') return true;
	const host = url.hostname.toLowerCase();
	return url.protocol === 'http:' && (LOOPBACK_HOSTS.includes(host) || host.endsWith('.localhost'));
}

/** The execution's cancel signal; undefined in load-options calls and older n8n releases. */
export function cancelSignal(
	context: IExecuteFunctions | ILoadOptionsFunctions,
): AbortSignal | undefined {
	return 'getExecutionCancelSignal' in context
		? (context.getExecutionCancelSignal?.() as AbortSignal | undefined)
		: undefined;
}

export function isCancelled(context: IExecuteFunctions | ILoadOptionsFunctions): boolean {
	return cancelSignal(context)?.aborted === true;
}

function throwIfCancelled(context: IExecuteFunctions | ILoadOptionsFunctions): void {
	if (isCancelled(context)) throw new NodeOperationError(context.getNode(), CANCELLED_MESSAGE);
}

/** Waits `ms`, ending early and throwing when the execution is cancelled. */
async function cancellableSleep(
	context: IExecuteFunctions | ILoadOptionsFunctions,
	ms: number,
): Promise<void> {
	await sleep(ms, cancelSignal(context)).catch(() => undefined);
	throwIfCancelled(context);
}

/** Replaces every occurrence of the API key in a message the remote side could have shaped. */
export function redactSecret(message: string, secret: string | undefined): string {
	return secret && secret.length >= 4 ? message.split(secret).join('[redacted]') : message;
}

/**
 * Sends one request to the public API through the Zandovi credential and returns the response,
 * after waiting out short rate limits (AC2.6) and a concurrent twin of an idempotent render
 * (AC2.8). Every other error response, a timeout and a network failure throw a NodeApiError
 * with the message AC2.5, AC2.7 and AC2.9 give.
 */
export async function zandoviRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	request: ZandoviRequest,
): Promise<ZandoviResponse> {
	const credentials = await this.getCredentials<{ apiKey?: string; baseUrl?: string }>(
		'zandoviApi',
	);
	if (!isAllowedBaseUrl(credentials.baseUrl)) {
		throw zandoviError(this.getNode(), {
			message: BASE_URL_MESSAGE,
			status: null,
			code: 'INVALID_BASE_URL',
		});
	}
	const options: IHttpRequestOptions = {
		method: request.method,
		url: apiUrl(credentials.baseUrl, request.path),
		headers: { ...request.headers, 'User-Agent': userAgent() },
		timeout: REQUEST_TIMEOUT_MS,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// n8n strips only Authorization and Cookie on a cross-origin redirect, never X-Api-Key, and
		// the API never redirects, so a redirect is refused rather than followed.
		disableFollowRedirect: true,
	};
	if (request.qs !== undefined) options.qs = request.qs;
	if (request.body !== undefined) options.body = request.body;
	if (request.encoding === undefined) options.json = true;
	else options.encoding = request.encoding;

	let rateLimitRetries = 0;
	let inProgressRetries = 0;
	for (;;) {
		throwIfCancelled(this);
		let response: IN8nHttpFullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'zandoviApi',
				options,
			)) as IN8nHttpFullResponse;
		} catch (error) {
			throwIfCancelled(this);
			throw zandoviError(this.getNode(), transportFailure(error));
		}

		const { statusCode } = response;
		const headers = response.headers ?? {};
		if (statusCode >= 200 && statusCode < 300) return { statusCode, headers, body: response.body };
		if (statusCode < 400) {
			throw zandoviError(this.getNode(), {
				message: REDIRECT_MESSAGE,
				status: statusCode,
				code: 'UNEXPECTED_REDIRECT',
			});
		}

		const problem = parseProblem(response.body);
		if (statusCode === 429 && problem.code === 'RATE_LIMIT_EXCEEDED') {
			const wait = retryAfterSeconds(headers) ?? 1;
			if (wait > RATE_LIMIT_MAX_WAIT_SECONDS || rateLimitRetries >= RATE_LIMIT_MAX_RETRIES) {
				throw zandoviError(this.getNode(), {
					message: RATE_LIMIT_MESSAGE,
					status: statusCode,
					code: problem.code,
				});
			}
			rateLimitRetries++;
			await cancellableSleep(this, wait * 1000);
			continue;
		}
		if (statusCode === 409 && problem.code === 'IDEMPOTENCY_IN_PROGRESS') {
			if (inProgressRetries >= IN_PROGRESS_MAX_RETRIES) {
				throw zandoviError(this.getNode(), {
					message: IN_PROGRESS_MESSAGE,
					status: statusCode,
					code: problem.code,
				});
			}
			inProgressRetries++;
			await cancellableSleep(this, IN_PROGRESS_WAIT_MS);
			continue;
		}
		const failure = describeFailure(statusCode, problem, headers, request);
		failure.message = redactSecret(failure.message, credentials.apiKey);
		throw zandoviError(this.getNode(), failure);
	}
}
