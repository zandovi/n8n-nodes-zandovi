import { NodeApiError, sleep } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json';
import { zandoviRequest, userAgent } from '../nodes/Zandovi/transport/request';
import type { ZandoviRequest } from '../nodes/Zandovi/transport/request';
import { LEAK_SENTINEL, createContext, problem } from './helpers/context';
import type { FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const sleepMock = vi.mocked(sleep);

const GET_TEMPLATE: ZandoviRequest = {
	method: 'GET',
	path: '/templates/3fa85f64-5717-4562-b3fc-2c963f66afa6',
	resource: 'Template',
	operation: 'Template → Get',
};

async function send(
	replies: FakeReply[],
	request: ZandoviRequest = GET_TEMPLATE,
	baseUrl?: string,
) {
	const fake = createContext({ replies, baseUrl });
	const result = zandoviRequest.call(fake.context, request);
	return { ...fake, result };
}

async function failure(replies: FakeReply[], request: ZandoviRequest = GET_TEMPLATE) {
	const { result, calls } = await send(replies, request);
	const error = await result.then(
		() => {
			throw new Error('expected the request to fail');
		},
		(caught: NodeApiError) => caught,
	);
	expect(error).toBeInstanceOf(NodeApiError);
	return { error, calls };
}

const rateLimited = (retryAfter: string): FakeReply => ({
	statusCode: 429,
	headers: { 'retry-after': retryAfter },
	body: problem(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.'),
});

const ok: FakeReply = { statusCode: 200, headers: {}, body: { id: 'tpl' } };

beforeEach(() => {
	sleepMock.mockClear();
});

describe('request shape', () => {
	it('sends the exact request: Base URL + /api/v1, user agent, 120 s timeout, no Authorization (AC2.1, AC2.2, AC2.4, AC2.5)', async () => {
		const { result, calls, httpRequestWithAuthentication } = await send([ok]);
		await expect(result).resolves.toEqual({ statusCode: 200, headers: {}, body: { id: 'tpl' } });

		expect(httpRequestWithAuthentication).toHaveBeenCalledWith('zandoviApi', expect.anything());
		expect(calls).toEqual([
			{
				method: 'GET',
				url: 'https://app.zandovi.com/api/v1/templates/3fa85f64-5717-4562-b3fc-2c963f66afa6',
				headers: { 'User-Agent': `zandovi-n8n/${packageJson.version}` },
				timeout: 120_000,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				json: true,
			},
		]);
		expect(JSON.stringify(calls)).not.toMatch(/authorization/i);
	});

	it.each([
		['https://app.zandovi.com/', 'https://app.zandovi.com/api/v1/account'],
		['https://app.zandovi.com///', 'https://app.zandovi.com/api/v1/account'],
		['https://zandovi.example.com/proxy/', 'https://zandovi.example.com/proxy/api/v1/account'],
		['https://app.zandovi.com/api/v1', 'https://app.zandovi.com/api/v1/account'],
		['https://app.zandovi.com/api/v1/', 'https://app.zandovi.com/api/v1/account'],
		['https://app.zandovi.com/API/V1', 'https://app.zandovi.com/api/v1/account'],
		[
			'https://proxy.example.com/zandovi/api/v1/',
			'https://proxy.example.com/zandovi/api/v1/account',
		],
		['', 'https://app.zandovi.com/api/v1/account'],
	])('normalises the Base URL %j (E5, D-T10.1)', async (baseUrl, url) => {
		const { result, calls } = await send(
			[ok],
			{ method: 'GET', path: '/account', resource: 'Account', operation: 'Account' },
			baseUrl,
		);
		await result;
		expect(calls[0].url).toBe(url);
	});

	it('passes query, body and headers through, and asks for an arraybuffer when told', async () => {
		const { result, calls } = await send([ok], {
			method: 'POST',
			path: '/templates/tpl/generate',
			qs: { dryRun: 'false' },
			body: { variables: { name: 'Ada' } },
			headers: { 'Idempotency-Key': 'n8n-abc' },
			encoding: 'arraybuffer',
			resource: 'Template',
			operation: 'Template → Generate',
		});
		await result;
		expect(calls[0]).toMatchObject({
			method: 'POST',
			qs: { dryRun: 'false' },
			body: { variables: { name: 'Ada' } },
			headers: { 'Idempotency-Key': 'n8n-abc', 'User-Agent': `zandovi-n8n/${packageJson.version}` },
			encoding: 'arraybuffer',
		});
		expect(calls[0]).not.toHaveProperty('json');
	});
});

describe('userAgent (AC2.4, D-T2.3)', () => {
	it('is zandovi-n8n/<package version> when the n8n version is unknown', () => {
		expect(userAgent()).toBe(`zandovi-n8n/${packageJson.version}`);
		expect(userAgent('')).toBe(`zandovi-n8n/${packageJson.version}`);
	});

	it('appends n8n/<n8n version> when the n8n version is known', () => {
		expect(userAgent('1.119.2')).toBe(`zandovi-n8n/${packageJson.version} n8n/1.119.2`);
	});
});

describe('429 rate limit (AC2.6, E9)', () => {
	it('waits Retry-After seconds and retries the same request', async () => {
		const request: ZandoviRequest = {
			...GET_TEMPLATE,
			headers: { 'Idempotency-Key': 'n8n-key-1' },
		};
		const { result, calls } = await send([rateLimited('5'), ok], request);
		await expect(result).resolves.toMatchObject({ statusCode: 200 });
		expect(sleepMock.mock.calls).toEqual([[5000, undefined]]);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(calls[0]);
		expect(calls[1].headers).toMatchObject({ 'Idempotency-Key': 'n8n-key-1' });
	});

	it('retries at most 3 times, then fails with the rate-limit message', async () => {
		const { error, calls } = await failure([
			rateLimited('2'),
			rateLimited('2'),
			rateLimited('2'),
			rateLimited('2'),
		]);
		expect(calls).toHaveLength(4);
		expect(sleepMock.mock.calls).toEqual([
			[2000, undefined],
			[2000, undefined],
			[2000, undefined],
		]);
		expect(error.message).toBe('Zandovi rate limit reached; retry later');
		expect(error.httpCode).toBe('429');
	});

	it('waits exactly 30 s, but fails at once when Retry-After is above 30 s', async () => {
		const accepted = await send([rateLimited('30'), ok]);
		await accepted.result;
		expect(sleepMock.mock.calls).toEqual([[30_000, undefined]]);

		sleepMock.mockClear();
		const { error, calls } = await failure([rateLimited('31')]);
		expect(calls).toHaveLength(1);
		expect(sleepMock).not.toHaveBeenCalled();
		expect(error.message).toBe('Zandovi rate limit reached; retry later');
	});
});

describe('monthly quota (AC2.7, E7)', () => {
	it('fails at once on QUOTA_EXCEEDED, dating the reset from Retry-After', async () => {
		vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] });
		try {
			const secondsToDecember = (Date.parse('2026-12-01T00:00:00Z') - Date.now()) / 1000;
			const { error, calls } = await failure([
				{
					statusCode: 429,
					headers: { 'Retry-After': String(secondsToDecember) },
					body: problem(429, 'QUOTA_EXCEEDED', 'Monthly API request quota exceeded.'),
				},
			]);
			expect(calls).toHaveLength(1);
			expect(sleepMock).not.toHaveBeenCalled();
			expect(error.message).toBe(
				'Monthly render quota used up; it resets on 2026-12-01. Upgrade at app.zandovi.com/plans.',
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('prefers X-Quota-Reset for the date', async () => {
		const { error } = await failure([
			{
				statusCode: 429,
				headers: { 'x-quota-reset': '2027-01-01T00:00:00Z', 'retry-after': '99999' },
				body: problem(429, 'QUOTA_EXCEEDED', 'Monthly API request quota exceeded.'),
			},
		]);
		expect(error.message).toBe(
			'Monthly render quota used up; it resets on 2027-01-01. Upgrade at app.zandovi.com/plans.',
		);
	});

	it('treats BATCH_RATE_LIMIT_EXCEEDED with a monthly-quota detail as quota exhaustion', async () => {
		const { error, calls } = await failure([
			{
				statusCode: 429,
				headers: { 'x-quota-reset': '2026-12-01T00:00:00Z' },
				body: problem(429, 'BATCH_RATE_LIMIT_EXCEEDED', 'Monthly render quota exceeded', {
					details: { used: 100, quota: 100, requested: 3 },
				}),
			},
		]);
		expect(calls).toHaveLength(1);
		expect(sleepMock).not.toHaveBeenCalled();
		expect(error.message).toBe(
			'Monthly render quota used up; it resets on 2026-12-01. Upgrade at app.zandovi.com/plans.',
		);
	});

	it('does not wait on a concurrent-batch BATCH_RATE_LIMIT_EXCEEDED and shows its detail', async () => {
		const { error, calls } = await failure([
			{
				statusCode: 429,
				headers: { 'retry-after': '1' },
				body: problem(429, 'BATCH_RATE_LIMIT_EXCEEDED', 'Concurrent batch limit exceeded'),
			},
		]);
		expect(calls).toHaveLength(1);
		expect(sleepMock).not.toHaveBeenCalled();
		expect(error.message).toBe('Concurrent batch limit exceeded');
	});
});

describe('409 IDEMPOTENCY_IN_PROGRESS (AC2.8)', () => {
	const inProgress: FakeReply = {
		statusCode: 409,
		body: problem(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this key is in progress.'),
	};

	it('waits 2 s and retries with the same Idempotency-Key', async () => {
		const request: ZandoviRequest = {
			...GET_TEMPLATE,
			headers: { 'Idempotency-Key': 'n8n-key-2' },
		};
		const { result, calls } = await send([inProgress, inProgress, ok], request);
		await expect(result).resolves.toMatchObject({ statusCode: 200 });
		expect(sleepMock.mock.calls).toEqual([
			[2000, undefined],
			[2000, undefined],
		]);
		expect(calls.map((call) => call.headers?.['Idempotency-Key'])).toEqual([
			'n8n-key-2',
			'n8n-key-2',
			'n8n-key-2',
		]);
	});

	it('retries at most 5 times, then fails', async () => {
		const { error, calls } = await failure(Array.from({ length: 6 }, () => inProgress));
		expect(calls).toHaveLength(6);
		expect(sleepMock).toHaveBeenCalledTimes(5);
		expect(error.message).toBe('A previous attempt of this render is still running');
	});
});

describe('error mapping (AC2.9)', () => {
	it('400: the detail plus every listed error, each naming its field or variable', async () => {
		const { error } = await failure([
			{
				statusCode: 400,
				body: problem(400, 'VALIDATION_ERROR', 'Request validation failed', {
					violations: [{ field: 'format', message: 'must be one of png, jpeg, webp, pdf' }],
					errors: [{ variable: 'discount_code', message: 'is required' }],
				}),
			},
		]);
		expect(error.message).toBe(
			'Request validation failed; discount_code: is required; format: must be one of png, jpeg, webp, pdf',
		);
		expect(error.httpCode).toBe('400');
	});

	it('400: reads a details list and a details.errors list too', async () => {
		const { error } = await failure([
			{
				statusCode: 400,
				body: problem(400, 'BATCH_ITEM_INVALID', 'Row 2 is invalid', {
					details: { itemIndex: 2, errors: [{ field: 'name', message: 'too long' }] },
				}),
			},
		]);
		expect(error.message).toBe('Row 2 is invalid; name: too long');

		const listed = await failure([
			{
				statusCode: 400,
				body: problem(400, 'VALIDATION_ERROR', 'Bad variables', {
					details: [{ variable: 'qr', message: 'not a URL' }],
				}),
			},
		]);
		expect(listed.error.message).toBe('Bad variables; qr: not a URL');
	});

	it('400: decodes an error body that arrived as a binary buffer', async () => {
		const body = Buffer.from(JSON.stringify(problem(400, 'VALIDATION_ERROR', 'Unknown format')));
		const { error } = await failure([{ statusCode: 400, body }], {
			...GET_TEMPLATE,
			encoding: 'arraybuffer',
		});
		expect(error.message).toBe('Unknown format');
	});

	it.each([
		[
			401,
			problem(401, 'UNAUTHORIZED', 'Invalid API key'),
			'Invalid or revoked API key. Create one under Settings → API Keys.',
		],
		[
			402,
			problem(
				402,
				'OUTPUT_SIZE_LIMIT_EXCEEDED',
				'Output size 8000x8000 exceeds your plan limit of 4000x4000',
			),
			'Output size 8000x8000 exceeds your plan limit of 4000x4000',
		],
		[
			403,
			problem(
				403,
				'INSUFFICIENT_SCOPE',
				"This credential does not have the 'templates:read' scope required for this operation.",
				{
					details: { requiredScope: 'templates:read' },
				},
			),
			'This API key lacks the `templates:read` scope needed for Template → Get; create a key that has it',
		],
		[
			403,
			problem(403, 'FORBIDDEN', 'This template belongs to another member'),
			'This template belongs to another member',
		],
		[
			404,
			problem(404, 'NOT_FOUND', 'Template 3fa8 not found'),
			"Template not found, or not visible to this API key's account",
		],
		[
			422,
			problem(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused'),
			'This Idempotency Key was already used with different inputs',
		],
		[
			422,
			problem(422, 'IMAGE_VARIABLE_UNREACHABLE', 'Image variable logo could not be fetched'),
			'Image variable logo could not be fetched. Upload it first with Image → Upload',
		],
		[
			500,
			problem(500, 'INTERNAL_ERROR', 'boom'),
			'Zandovi service error (500); retry later',
		],
		[502, 'Bad Gateway', 'Zandovi service error (502); retry later'],
		[503, '', 'Zandovi service error (503); retry later'],
	])('%i maps to its message', async (statusCode, body, message) => {
		const { error, calls } = await failure([{ statusCode, body }]);
		expect(error.message).toBe(message);
		expect(error.httpCode).toBe(String(statusCode));
		expect(calls).toHaveLength(1);
		expect(sleepMock).not.toHaveBeenCalled();
	});

	it('404 names the resource the operation passes', async () => {
		const { error } = await failure([{ statusCode: 404, body: problem(404, 'NOT_FOUND', 'x') }], {
			method: 'GET',
			path: '/batch-jobs/job-1',
			resource: 'Batch job',
			operation: 'Batch Job → Get',
		});
		expect(error.message).toBe("Batch job not found, or not visible to this API key's account");
	});

	it('a key with only account:read fails the first operation with the scope message (E6)', async () => {
		const { error } = await failure(
			[
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'missing scope', {
						details: { requiredScope: 'render' },
					}),
				},
			],
			{
				method: 'POST',
				path: '/templates/t/generate',
				resource: 'Template',
				operation: 'Template → Generate',
			},
		);
		expect(error.message).toBe(
			'This API key lacks the `render` scope needed for Template → Generate; create a key that has it',
		);
	});
});

describe('timeouts and network failures (AC2.5)', () => {
	it('surfaces a timeout as "Zandovi did not respond within 120 s"', async () => {
		const axiosTimeout = Object.assign(new Error('timeout of 120000ms exceeded'), {
			code: 'ECONNABORTED',
			config: { headers: { 'X-Api-Key': LEAK_SENTINEL } },
		});
		// n8n wraps what axios throws in a NodeApiError whose cause is the axios error.
		const wrapped = new Error('The connection was aborted, perhaps the server is offline', {
			cause: axiosTimeout,
		});
		const { error, calls } = await failure([{ throws: wrapped }]);
		expect(error.message).toBe('Zandovi did not respond within 120 s');
		expect(calls).toHaveLength(1);
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	it('reports an unreachable host without the key', async () => {
		const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
			code: 'ECONNREFUSED',
			config: { headers: { 'X-Api-Key': LEAK_SENTINEL } },
		});
		const { error } = await failure([{ throws: refused }]);
		expect(error.message).not.toBe('');
		expect(`${error.message} ${error.description} ${JSON.stringify(error)}`).not.toContain(
			LEAK_SENTINEL,
		);
	});
});

describe('the API key never reaches an error (AC2.11)', () => {
	it.each([
		[401, problem(401, 'UNAUTHORIZED', 'Invalid API key')],
		[
			400,
			problem(400, 'VALIDATION_ERROR', 'Request validation failed', {
				violations: [{ field: 'variables.name', message: 'is required' }],
			}),
		],
	])('%i', async (statusCode, body) => {
		const { error } = await failure([{ statusCode, body }]);
		const exposed = [
			error.message,
			String(error.description),
			JSON.stringify(error),
			JSON.stringify(error.errorResponse),
			JSON.stringify(error.context),
			String(error.stack),
		].join('\n');
		expect(exposed).not.toContain(LEAK_SENTINEL);
	});
});
