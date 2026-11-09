import type { IBinaryData, IDataObject, IExecuteFunctions, NodeApiError } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchJobResource } from '../nodes/Zandovi/resources/batchJob';
import { TIMEOUT_RANGE_MESSAGE } from '../nodes/Zandovi/resources/batchJob/submit';
import { imageResource } from '../nodes/Zandovi/resources/image';
import { templateResource } from '../nodes/Zandovi/resources/template';
import { getLibraryTemplates } from '../nodes/Zandovi/resources/template/createFromLibrary';
import { SHARED_KEY_MESSAGE } from '../nodes/Zandovi/resources/template/generate';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import { REDIRECT_MESSAGE } from '../nodes/Zandovi/transport/errors';
import {
	BASE_URL_MESSAGE,
	CANCELLED_MESSAGE,
	isAllowedBaseUrl,
	zandoviRequest,
} from '../nodes/Zandovi/transport/request';
import type { ZandoviRequest } from '../nodes/Zandovi/transport/request';
import { LEAK_SENTINEL, createContext, probeResource, problem } from './helpers/context';
import type { FakeContextOptions, FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const TEMPLATE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const JOB_ID = '5b2c7e1a-8d3f-4c6b-9a1e-0f2d3c4b5a69';
const API = 'https://app.zandovi.com/api/v1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const GET_ACCOUNT: ZandoviRequest = {
	method: 'GET',
	path: '/account',
	resource: 'Account',
	operation: 'Account',
};

async function rejection(result: Promise<unknown>) {
	return (await result.then(
		() => {
			throw new Error('expected a failure');
		},
		(caught: NodeApiError) => caught,
	)) as NodeApiError;
}

/** A context whose execution cancel signal is the given controller's. */
function withCancelSignal<T extends { context: IExecuteFunctions }>(
	fake: T,
	controller: AbortController,
): T {
	Object.assign(fake.context, { getExecutionCancelSignal: () => controller.signal });
	return fake;
}

beforeEach(() => {
	vi.mocked(sleep).mockClear();
	vi.mocked(sleep).mockImplementation(async () => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('redirects are never followed with the API key (review: credential forwarding)', () => {
	it('asks n8n not to follow redirects', async () => {
		const fake = createContext({ replies: [{ statusCode: 200, body: {} }] });
		await zandoviRequest.call(fake.context, GET_ACCOUNT);
		expect(fake.calls[0].disableFollowRedirect).toBe(true);
	});

	it.each([301, 302, 307, 308])(
		'fails on a %i instead of treating it as success',
		async (status) => {
			const fake = createContext({
				replies: [{ statusCode: status, headers: { location: 'https://evil.example/' }, body: '' }],
			});
			const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
			expect(error.message).toBe(REDIRECT_MESSAGE);
			expect(error.errorResponse).toMatchObject({ status, code: 'UNEXPECTED_REDIRECT' });
			expect(fake.calls).toHaveLength(1);
		},
	);
});

describe('Base URL validation (review: plaintext and malformed Base URLs)', () => {
	it.each([
		'https://app.zandovi.com',
		'https://proxy.example.com/zandovi/api/v1/',
		'http://localhost:8080',
		'http://127.0.0.1:8080',
		'http://[::1]:8080',
		'http://zandovi.localhost',
	])('accepts %s', (baseUrl) => {
		expect(isAllowedBaseUrl(baseUrl)).toBe(true);
	});

	it.each([
		'http://app.zandovi.com',
		'https://user:secret@app.zandovi.com',
		'https://app.zandovi.com?x=1',
		'https://app.zandovi.com#fragment',
		'ftp://app.zandovi.com',
		'not a url',
	])('refuses %s before any request is sent', async (baseUrl) => {
		const fake = createContext({ replies: [], baseUrl });
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe(BASE_URL_MESSAGE);
		expect(error.errorResponse).toMatchObject({ code: 'INVALID_BASE_URL' });
		expect(fake.calls).toHaveLength(0);
	});

	it('uses the default when the credential has no Base URL', async () => {
		const fake = createContext({ replies: [{ statusCode: 200, body: {} }], baseUrl: null });
		await zandoviRequest.call(fake.context, GET_ACCOUNT);
		expect(fake.calls[0].url).toBe(`${API}/account`);
	});
});

describe('secret-safe error messages (review: error redaction)', () => {
	it('never shows the raw message of a network error without a system code', async () => {
		const fake = createContext({
			replies: [{ throws: new Error(`request failed, X-Api-Key: ${LEAK_SENTINEL}`) }],
		});
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe('Could not reach Zandovi (network error)');
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	it('drops the raw message of a network error that has a system code', async () => {
		const refused = Object.assign(new Error(`boom ${LEAK_SENTINEL}`), { code: 'ECONNREFUSED' });
		const fake = createContext({ replies: [{ throws: refused }] });
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe('Could not reach Zandovi (ECONNREFUSED)');
		expect(error.errorResponse).toMatchObject({ code: 'ECONNREFUSED' });
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	it.each([
		[400, 'VALIDATION_ERROR'],
		[403, 'FORBIDDEN'],
		[422, 'UNPROCESSABLE'],
	])('redacts the API key from a reflected %i detail', async (status, code) => {
		const fake = createContext({
			replies: [{ statusCode: status, body: problem(status, code, `Bad key ${LEAK_SENTINEL}`) }],
		});
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe('Bad key [redacted]');
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	// Found in a live n8n run: NodeApiError rewrites any message containing a Node error code,
	// and "reuseExisting" contains EEXIST.
	it.each([
		'Unrecognized field "reuseExisting"',
		'Field reuseExisting must be a boolean; ENOENT EPERM ETIMEDOUT are just words here',
	])('keeps Zandovi’s message even when it contains a Node error code: %s', async (detail) => {
		const fake = createContext({
			replies: [{ statusCode: 400, body: problem(400, 'VALIDATION_ERROR', detail) }],
		});
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe(detail);
		expect(error.message).not.toMatch(/file or directory/);
	});

	// Found in a live n8n run: the batch rejection named only the template.
	it('names the row and each broken rule of a batch validation failure', async () => {
		const body = problem(400, 'VARIABLE_VALIDATION_FAILED', 'Variable validation failed', {
			details: {
				itemIndex: 1,
				templateName: 'n8n Smoke: All Variable Types',
				errors: { code: 'Does not match required pattern', amount: 'Must not exceed 99.0' },
			},
		});
		const fake = createContext({ replies: [{ statusCode: 400, body }] });
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe(
			'Variable validation failed; row 2, code: Does not match required pattern; row 2, amount: Must not exceed 99.0',
		);
	});

	it('does not repeat listed errors that the detail already spells out', async () => {
		const detail = 'reuseExisting: Unknown property; projectId: Project ID is required';
		const errors = [
			{ field: 'reuseExisting', message: 'Unknown property' },
			{ field: 'projectId', message: 'Project ID is required' },
			{ field: 'name', message: 'Too long' },
		];
		const fake = createContext({
			replies: [{ statusCode: 400, body: problem(400, 'VALIDATION_ERROR', detail, { errors }) }],
		});
		const error = await rejection(zandoviRequest.call(fake.context, GET_ACCOUNT));
		expect(error.message).toBe(`${detail}; name: Too long`);
	});
});

describe('cancellation (review: cancellation only partially implemented)', () => {
	const items = [{ json: {} }, { json: {} }, { json: {} }];
	const probeParameters = (name: string, itemIndex: number) =>
		({ resource: 'probe', operation: 'get', probeId: `p${itemIndex}` })[name];
	const rateLimited: FakeReply = {
		statusCode: 429,
		headers: { 'retry-after': '1' },
		body: problem(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests'),
	};

	it('sends no request once the execution is cancelled, even with Continue On Fail', async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = withCancelSignal(
			createContext({ replies: [], items, parameters: probeParameters, continueOnFail: true }),
			controller,
		);
		const error = await rejection(executeItems.call(fake.context, [probeResource]));
		expect(error.message).toBe(CANCELLED_MESSAGE);
		expect(fake.calls).toHaveLength(0);
	});

	it('ends a rate-limit wait on cancellation and starts no further item', async () => {
		const controller = new AbortController();
		vi.mocked(sleep).mockImplementation(async (_ms: number, signal?: AbortSignal) => {
			controller.abort();
			if (signal?.aborted) throw new Error('aborted');
		});
		const fake = withCancelSignal(
			createContext({
				replies: [rateLimited, { statusCode: 200, body: {} }],
				items,
				parameters: probeParameters,
				continueOnFail: true,
			}),
			controller,
		);
		const error = await rejection(executeItems.call(fake.context, [probeResource]));
		expect(error.message).toBe(CANCELLED_MESSAGE);
		expect(vi.mocked(sleep).mock.calls[0][1]).toBe(controller.signal);
		expect(fake.calls).toHaveLength(1);
	});
});

describe('Library index (review: public library fetched with the API key)', () => {
	const index = { templates: [{ id: 'coupon', name: 'Coupon', variableCount: 2 }] };

	it('fetches the index without the credential', async () => {
		const fake = createContext({ replies: [{ statusCode: 200, body: index }] });
		const options = await getLibraryTemplates.call(fake.context as never);
		expect(options).toEqual([{ name: 'Coupon (2 variables)', value: 'coupon' }]);
		expect(fake.httpRequest).toHaveBeenCalledTimes(1);
		expect(fake.httpRequestWithAuthentication).not.toHaveBeenCalled();
		expect(JSON.stringify(fake.calls)).not.toContain(LEAK_SENTINEL);
	});

	it('refuses a plaintext Base URL', async () => {
		const fake = createContext({ replies: [], baseUrl: 'http://app.zandovi.com' });
		await expect(getLibraryTemplates.call(fake.context as never)).rejects.toThrow(BASE_URL_MESSAGE);
		expect(fake.calls).toHaveLength(0);
	});
});

describe('Template → Generate (review: metadata decoding, shared custom key)', () => {
	function generateParameters(overrides: IDataObject = {}) {
		return (name: string, itemIndex: number): unknown =>
			({
				resource: 'template',
				operation: 'generate',
				templateId: { __rl: true, mode: 'id', value: TEMPLATE_ID },
				variables: {
					mappingMode: 'defineBelow',
					value: { name: `Customer ${itemIndex}` },
					matchingColumns: [],
					schema: [],
				},
				delivery: 'binary',
				format: 'png',
				binaryPropertyName: 'data',
				options: {},
				...overrides,
			})[name];
	}
	const rendered: FakeReply = {
		statusCode: 200,
		headers: { 'content-type': 'image/png' },
		body: PNG,
	};

	function run(
		replies: FakeReply[],
		parameters: FakeContextOptions['parameters'],
		extra: Partial<FakeContextOptions> = {},
	) {
		const fake = createContext({ replies, parameters, executionId: 'exec-1', ...extra });
		return { ...fake, result: executeItems.call(fake.context, [templateResource]) };
	}

	it('keeps a successful render when X-Unknown-Variables is not valid percent-encoding', async () => {
		const { result } = run(
			[{ ...rendered, headers: { ...rendered.headers, 'x-unknown-variables': 'bad%,caf%C3%A9' } }],
			generateParameters(),
		);
		const [[item]] = await result;
		expect(item.json.unknownVariables).toEqual(['bad%', 'café']);
		expect(item.binary?.data).toBeDefined();
	});

	it('fails a static custom key shared by different items before any render is charged', async () => {
		const items = [{ json: {} }, { json: {} }];
		const { result, calls } = run(
			[],
			generateParameters({ options: { idempotencyKey: 'static-key' } }),
			{ items },
		);
		const error = await rejection(result);
		expect(error.message).toBe(SHARED_KEY_MESSAGE);
		expect(calls).toHaveLength(0);
	});

	it('with Continue On Fail, fails every item that shares the key and renders the rest', async () => {
		const items = [{ json: {} }, { json: {} }, { json: {} }];
		const keys = ['shared', 'own', 'shared'];
		const base = generateParameters();
		const parameters = (name: string, itemIndex: number) =>
			name === 'options' ? { idempotencyKey: keys[itemIndex] } : base(name, itemIndex);
		const { result, calls } = run([rendered], parameters, { items, continueOnFail: true });
		const [output] = await result;
		expect(output.map((item) => item.json.error ?? 'rendered')).toEqual([
			SHARED_KEY_MESSAGE,
			'rendered',
			SHARED_KEY_MESSAGE,
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].headers).toMatchObject({ 'Idempotency-Key': 'own' });
	});

	it('allows one key for items that render the same content (a replay)', async () => {
		const items = [{ json: {} }, { json: {} }];
		const base = generateParameters({ options: { idempotencyKey: 'same' } });
		const parameters = (name: string, itemIndex: number) =>
			name === 'variables' ? base(name, 0) : base(name, itemIndex);
		const { result, calls } = run([rendered, rendered], parameters, { items });
		await result;
		expect(calls).toHaveLength(2);
	});
});

describe('dynamic path segments are encoded (review: project ID interpolation)', () => {
	it('keeps an expression-supplied project ID inside its path segment', async () => {
		const fake = createContext({
			replies: [{ statusCode: 200, body: { data: [], pagination: { page: 0, totalPages: 0 } } }],
			parameters: {
				resource: 'template',
				operation: 'getAll',
				projectId: '../account?x=1#y',
				returnAll: true,
			},
		});
		await executeItems.call(fake.context, [templateResource]);
		expect(fake.calls[0].url).toBe(`${API}/projects/..%2Faccount%3Fx%3D1%23y/templates`);
	});
});

describe('Batch Job (review: 409 rewrite, timeout bounds)', () => {
	const items = [{ json: {} }, { json: {} }];
	function submitParameters(overrides: IDataObject = {}) {
		return (name: string): unknown =>
			({
				resource: 'batchJob',
				operation: 'submit',
				templateId: { __rl: true, mode: 'id', value: TEMPLATE_ID },
				variables: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] },
				format: 'png',
				waitForCompletion: true,
				timeoutMinutes: 1,
				options: {},
				...overrides,
			})[name];
	}
	const account: FakeReply = { statusCode: 200, body: { limits: { maxBatchRowsPerJob: 100 } } };
	const submitted: FakeReply = { statusCode: 202, body: { jobId: JOB_ID, status: 'PENDING' } };
	const processing: FakeReply = { statusCode: 200, body: { jobId: JOB_ID, status: 'PROCESSING' } };

	it('Get Result shows a 409 other than BATCH_RESULT_NOT_READY as it is, without reading the job', async () => {
		const fake = createContext({
			replies: [
				{ statusCode: 409, body: problem(409, 'SOME_CONFLICT', 'Something else conflicts') },
			],
			parameters: { resource: 'batchJob', operation: 'getResult', jobId: JOB_ID },
		});
		const error = await rejection(executeItems.call(fake.context, [batchJobResource]));
		expect(error.message).toBe('Something else conflicts');
		expect(fake.calls).toHaveLength(1);
	});

	it.each([0, 61, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses a Timeout of %s before reading the account or submitting',
		async (timeoutMinutes) => {
			const fake = createContext({
				replies: [],
				items,
				parameters: submitParameters({ timeoutMinutes }),
				executionId: 'exec-1',
			});
			const error = await rejection(executeItems.call(fake.context, [batchJobResource]));
			expect(error.message).toBe(TIMEOUT_RANGE_MESSAGE);
			expect(fake.calls).toHaveLength(0);
		},
	);

	it('never waits past the deadline when polls take time', async () => {
		let clock = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
		// Each wait also stands for 1.5 s of request time, so the deadline is not a multiple of 5 s.
		vi.mocked(sleep).mockImplementation(async (ms: number) => {
			clock += ms + 1_500;
		});
		const fake = createContext({
			replies: [account, submitted, ...Array.from({ length: 20 }, () => processing)],
			items,
			parameters: submitParameters(),
			executionId: 'exec-1',
		});
		const error = await rejection(executeItems.call(fake.context, [batchJobResource]));
		expect(error.message).toMatch(`Batch job ${JOB_ID} is still PROCESSING after 1 min`);
		const waits = vi.mocked(sleep).mock.calls.map((call) => call[0]);
		expect(waits.slice(0, -1).every((ms) => ms === 5_000)).toBe(true);
		expect(waits.at(-1)).toBe(1_500);
		expect(clock - 1_000_000).toBeLessThanOrEqual(60_000 + 1_500);
	});
});

describe('Image (review: upload buffering, pagination progress)', () => {
	function runUpload(binary: IBinaryData, metadataSize?: number) {
		const fake = createContext({
			replies: [],
			items: [{ json: {}, binary: { data: binary } }],
			parameters: { resource: 'image', operation: 'upload', source: 'binary', options: {} },
		});
		const helpers = fake.context.helpers as unknown as IDataObject;
		const getBinaryDataBuffer = vi.fn(async () => PNG);
		helpers.getBinaryDataBuffer = getBinaryDataBuffer;
		helpers.getBinaryMetadata = vi.fn(async () => ({ fileSize: metadataSize }));
		return {
			...fake,
			getBinaryDataBuffer,
			result: executeItems.call(fake.context, [imageResource]),
		};
	}
	const SIX_MB = 6 * 1024 * 1024;

	it.each([
		['n8n bytes', { data: '', bytes: SIX_MB }, undefined],
		['stored file metadata', { data: 'filesystem-v2', id: 'filesystem-v2:abc' }, SIX_MB],
		['inline base64 length', { data: Buffer.alloc(SIX_MB).toString('base64') }, undefined],
	])('refuses an oversized file from its %s without reading it', async (_label, extra, size) => {
		const run = runUpload(
			{ mimeType: 'image/png', fileName: 'big.png', ...extra } as IBinaryData,
			size,
		);
		await expect(run.result).rejects.toThrow('Image is 6.0 MB; the limit is 5 MB');
		expect(run.getBinaryDataBuffer).not.toHaveBeenCalled();
		expect(run.calls).toHaveLength(0);
	});

	it('stops Get Many when the API repeats a cursor', async () => {
		const page = (id: string, nextCursor: string) => ({
			statusCode: 200,
			body: { items: [{ id }], nextCursor },
		});
		const fake = createContext({
			replies: [page('a', 'c1'), page('b', 'c1')],
			parameters: { resource: 'image', operation: 'getMany', q: '', returnAll: true },
		});
		const [output] = await executeItems.call(fake.context, [imageResource]);
		expect(output.map((item) => item.json.id)).toEqual(['a', 'b']);
		expect(fake.calls).toHaveLength(2);
	});

	it('stops Get Many on an empty page that still claims a next cursor', async () => {
		const fake = createContext({
			replies: [{ statusCode: 200, body: { items: [], nextCursor: 'c1' } }],
			parameters: { resource: 'image', operation: 'getMany', q: '', returnAll: true },
		});
		const [output] = await executeItems.call(fake.context, [imageResource]);
		expect(output).toEqual([]);
		expect(fake.calls).toHaveLength(1);
	});
});
