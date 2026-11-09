import { createHash } from 'crypto';
import type { IDataObject, INodeProperties, NodeApiError } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import { batchJobResource } from '../nodes/Zandovi/resources/batchJob';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import packageJson from '../package.json';
import { LEAK_SENTINEL, createContext, problem } from './helpers/context';
import type { FakeContextOptions, FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const TEMPLATE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const JOB_ID = '5b2c7e1a-8d3f-4c6b-9a1e-0f2d3c4b5a69';
const API = 'https://app.zandovi.com/api/v1';
const USER_AGENT = `zandovi-n8n/${packageJson.version}`;

const batchKey = (workflowId: string, executionId: string, runIndex = 0) =>
	`n8n-${createHash('sha256').update(`${workflowId}:${executionId}:Zandovi:${runIndex}:batch`).digest('hex')}`;

const items = [
	{ json: { name: 'Ana', amount: 10, vip: true, note: '' } },
	{ json: { name: 'Ben', amount: 2.5, vip: false, note: null } },
	{ json: { name: 'Cleo', amount: 0, vip: true, note: 'hi' } },
];
const allPaired = [{ item: 0 }, { item: 1 }, { item: 2 }];

function submitParameters(overrides: IDataObject = {}) {
	return (name: string, itemIndex: number): unknown => {
		const item = items[itemIndex]?.json ?? {};
		const parameters: IDataObject = {
			resource: 'batchJob',
			operation: 'submit',
			templateId: { __rl: true, mode: 'id', value: TEMPLATE_ID },
			variables: {
				mappingMode: 'defineBelow',
				value: { name: item.name, amount: item.amount, vip: item.vip, note: item.note },
				matchingColumns: [],
				schema: [],
			},
			format: 'png',
			waitForCompletion: false,
			timeoutMinutes: 10,
			options: {},
			...overrides,
		};
		return parameters[name];
	};
}

const account = (maxBatchRowsPerJob: number | null): FakeReply => ({
	statusCode: 200,
	body: { scopes: ['render', 'templates:read'], limits: { maxBatchRowsPerJob } },
});
const submitted: FakeReply = {
	statusCode: 202,
	body: { jobId: JOB_ID, status: 'PENDING', totalItems: 3, createdAt: '2026-11-05T10:00:00Z' },
};
const job = (status: string, extra: IDataObject = {}): IDataObject => ({
	jobId: JOB_ID,
	status,
	totalItems: 3,
	completedItems: status === 'COMPLETED' ? 2 : 0,
	failedItems: status === 'COMPLETED' ? 1 : 0,
	processedItems: status === 'COMPLETED' ? 3 : 0,
	...extra,
});
const polled = (status: string, extra: IDataObject = {}): FakeReply => ({
	statusCode: 200,
	body: job(status, extra),
});

function run(
	replies: FakeReply[],
	parameters: FakeContextOptions['parameters'],
	extra: Partial<FakeContextOptions> = {},
) {
	const fake = createContext({ replies, parameters, executionId: 'exec-1', ...extra });
	return { ...fake, result: executeItems.call(fake.context, [batchJobResource]) };
}

async function failureOf(result: Promise<unknown>) {
	return (await result.then(
		() => {
			throw new Error('expected the operation to fail');
		},
		(caught: NodeApiError) => caught,
	)) as NodeApiError;
}

beforeEach(() => {
	vi.mocked(sleep).mockClear();
	vi.mocked(sleep).mockImplementation(async () => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Batch Job resource fields (AC6.1, AC6.10, AC6.11, E28)', () => {
	const properties = new Zandovi().description.properties;
	const field = (name: string, operation: string) =>
		properties.find(
			(property) =>
				property.name === name &&
				property.displayOptions?.show?.resource?.includes('batchJob') &&
				property.displayOptions?.show?.operation?.includes(operation),
		) as INodeProperties;
	const optionNames = (property: INodeProperties) =>
		((property.options ?? []) as INodeProperties[]).map((option) => option.name);

	it('registers Batch Job with Submit, Get, Get Items, Get Result and Cancel', () => {
		const resource = properties.find((property) => property.name === 'resource');
		expect(resource?.options).toContainEqual(expect.objectContaining({ value: 'batchJob' }));
		const operation = properties.find(
			(property) =>
				property.name === 'operation' &&
				property.displayOptions?.show?.resource?.includes('batchJob'),
		);
		expect((operation?.options as Array<{ value: string }>).map((option) => option.value)).toEqual([
			'submit',
			'get',
			'getItems',
			'getResult',
			'cancel',
		]);
	});

	it('gives Submit the template locator, the variables mapper, Format, Wait for Completion and Timeout', () => {
		const template = field('templateId', 'submit');
		expect(template.type).toBe('resourceLocator');
		expect(template.modes?.map((mode) => mode.name)).toEqual(['list', 'id']);
		expect(field('projectId', 'submit').displayOptions?.show?.['templateId.mode']).toEqual([
			'list',
		]);
		const variables = field('variables', 'submit');
		expect(variables.type).toBe('resourceMapper');
		expect(variables.typeOptions?.resourceMapper?.resourceMapperMethod).toBe(
			'getTemplateVariables',
		);
		expect(
			(field('format', 'submit').options as Array<{ value: string }>).map((option) => option.value),
		).toEqual(['png', 'jpeg', 'webp', 'pdf']);
		const wait = field('waitForCompletion', 'submit');
		expect(wait).toMatchObject({ type: 'boolean', default: true });
		const timeout = field('timeoutMinutes', 'submit');
		expect(timeout).toMatchObject({
			displayName: 'Timeout (Minutes)',
			type: 'number',
			default: 10,
			typeOptions: { minValue: 1, maxValue: 60 },
		});
		expect(timeout.displayOptions?.show?.waitForCompletion).toEqual([true]);
	});

	it('gives Submit the File Name Pattern, Output DPI, Scale, Callback URL and Idempotency Key options', () => {
		const options = field('options', 'submit');
		expect(optionNames(options).sort()).toEqual(
			['callbackUrl', 'filenamePattern', 'idempotencyKey', 'outputDpi', 'scale'].sort(),
		);
		const dpi = (options.options as INodeProperties[]).find((o) => o.name === 'outputDpi');
		expect((dpi?.options as Array<{ value: number }>).map((option) => option.value)).toEqual([
			96, 150, 300,
		]);
		const scale = (options.options as INodeProperties[]).find((o) => o.name === 'scale');
		expect(scale?.typeOptions).toMatchObject({ minValue: 1, maxValue: 4 });
	});

	it('gives each job operation a Job ID, Get Items Return All (on) and Limit, Get Result only a Job ID', () => {
		for (const operation of ['get', 'getItems', 'getResult', 'cancel']) {
			expect(field('jobId', operation)).toMatchObject({ type: 'string', required: true });
		}
		expect(field('returnAll', 'getItems')).toMatchObject({ type: 'boolean', default: true });
		expect(field('limit', 'getItems').displayOptions?.show?.returnAll).toEqual([false]);
		// The archive is never downloaded by the node: Get Result has no ZIP option.
		const getResultFields = new Zandovi().description.properties.filter((property) =>
			property.displayOptions?.show?.operation?.includes('getResult'),
		);
		expect(getResultFields.map((property) => property.name)).toEqual(['jobId']);
	});
});

describe('Batch Job → Submit', () => {
	it('reads the account once, sends one job with a row per item, and outputs one item paired to all inputs (AC6.1, AC6.3, AC6.4, AC6.7)', async () => {
		const { result, calls } = run([account(400), submitted], submitParameters(), {
			items,
			workflowId: 'wf-9',
			executionId: 'exec-7',
		});
		const [output] = await result;
		expect(output).toEqual([
			{
				json: { jobId: JOB_ID, status: 'PENDING', totalItems: 3, createdAt: '2026-11-05T10:00:00Z' },
				pairedItem: allPaired,
			},
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/account` });
		expect(calls[1]).toMatchObject({
			method: 'POST',
			url: `${API}/batch-jobs`,
			headers: { 'Idempotency-Key': batchKey('wf-9', 'exec-7'), 'User-Agent': USER_AGENT },
			body: {
				template: { templateId: TEMPLATE_ID, format: 'png' },
				rows: [
					{ name: 'Ana', amount: '10', vip: 'true' },
					{ name: 'Ben', amount: '2.5', vip: 'false' },
					{ name: 'Cleo', amount: '0', vip: 'true', note: 'hi' },
				],
			},
		});
		expect(calls[1].body).toEqual({
			template: { templateId: TEMPLATE_ID, format: 'png' },
			rows: [
				{ name: 'Ana', amount: '10', vip: 'true' },
				{ name: 'Ben', amount: '2.5', vip: 'false' },
				{ name: 'Cleo', amount: '0', vip: 'true', note: 'hi' },
			],
		});
		expect(sleep).not.toHaveBeenCalled();
	});

	it('sends the options as filenamePattern, render options and callbackUrl, and the key option verbatim (AC6.1, AC6.3, AC6.8)', async () => {
		const parameters = submitParameters({
			format: 'jpeg',
			options: {
				filenamePattern: '{name}-{index}',
				outputDpi: 150,
				callbackUrl: 'https://n8n.example.com/webhook-waiting/123',
				idempotencyKey: 'my-own-key',
			},
		});
		const { result, calls } = run([account(400), submitted], parameters, { items });
		await result;
		expect(calls[1].headers).toMatchObject({ 'Idempotency-Key': 'my-own-key' });
		expect(calls[1].body).toEqual({
			template: {
				templateId: TEMPLATE_ID,
				format: 'jpeg',
				options: { outputDpi: 150 },
				output: { filenamePattern: '{name}-{index}' },
			},
			rows: expect.any(Array),
			callbackUrl: 'https://n8n.example.com/webhook-waiting/123',
		});
	});

	it('sends Scale as options.scale', async () => {
		const { result, calls } = run(
			[account(400), submitted],
			submitParameters({ options: { scale: 2 } }),
			{ items },
		);
		await result;
		expect((calls[1].body as IDataObject).template).toEqual({
			templateId: TEMPLATE_ID,
			format: 'png',
			options: { scale: 2 },
		});
	});

	it('derives the same key on a retry in the same execution, and none without an execution id (AC6.3)', async () => {
		const first = run([account(400), submitted], submitParameters(), { items });
		await first.result;
		const retry = run([account(400), submitted], submitParameters(), { items });
		await retry.result;
		expect(first.calls[1].headers?.['Idempotency-Key']).toBe(batchKey('wf-1', 'exec-1'));
		expect(retry.calls[1].headers?.['Idempotency-Key']).toBe(batchKey('wf-1', 'exec-1'));

		const noExecution = run([account(400), submitted], submitParameters(), {
			items,
			executionId: undefined,
		});
		await noExecution.result;
		expect(noExecution.calls[1].headers).not.toHaveProperty('Idempotency-Key');
	});

	it('derives a new key for each run of the node in one execution, and keeps it on a retry within a run (AC6.3)', async () => {
		const run0 = run([account(400), submitted], submitParameters(), { items, runIndex: 0 });
		await run0.result;
		const run1 = run([account(400), submitted, account(400), submitted], submitParameters(), {
			items,
			runIndex: 1,
		});
		await run1.result;
		// Retry On Fail reruns the node inside the same run.
		await executeItems.call(run1.context, [batchJobResource]);
		expect(run0.calls[1].headers?.['Idempotency-Key']).toBe(batchKey('wf-1', 'exec-1', 0));
		expect(run1.calls[1].headers?.['Idempotency-Key']).toBe(batchKey('wf-1', 'exec-1', 1));
		expect(run1.calls[3].headers?.['Idempotency-Key']).toBe(batchKey('wf-1', 'exec-1', 1));
		expect(batchKey('wf-1', 'exec-1', 1)).not.toBe(batchKey('wf-1', 'exec-1', 0));
	});

	it('fails before reading anything when both Output DPI and Scale are set (AC3.10)', async () => {
		const { result, calls } = run([], submitParameters({ options: { outputDpi: 300, scale: 2 } }), {
			items,
		});
		const error = await failureOf(result);
		expect(error.message).toBe('Use either Output DPI or Scale, not both');
		expect(calls).toHaveLength(0);
	});

	it('fails without submitting when the items exceed the plan cap (AC6.2, E29)', async () => {
		const { result, calls } = run([account(2)], submitParameters(), { items });
		const error = await failureOf(result);
		expect(error.message).toBe(
			"3 items exceed your plan's limit of 2 rows per batch job. Put a Loop Over Items node with batch size 2 before this node.",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${API}/account`);
	});

	it('submits 300 items as one job on a plan whose cap is 400 (E29)', async () => {
		const many = Array.from({ length: 300 }, (_, index) => ({ json: { name: `n${index}` } }));
		const parameters = (name: string, itemIndex: number) =>
			submitParameters({
				variables: { mappingMode: 'defineBelow', value: { name: `n${itemIndex}` } },
			})(name, itemIndex);
		const { result, calls } = run([account(400), submitted], parameters, { items: many });
		const [output] = await result;
		expect(calls).toHaveLength(2);
		expect((calls[1].body as { rows: unknown[] }).rows).toHaveLength(300);
		expect(output).toHaveLength(1);
		expect(output[0].pairedItem).toHaveLength(300);
	});

	it('rejects a non-UUID template from an expression with the locator message (AC3.3)', async () => {
		const { result, calls } = run(
			[],
			submitParameters({ templateId: { __rl: true, mode: 'id', value: 'not-a-uuid' } }),
			{ items },
		);
		expect((await failureOf(result)).message).toBe('Enter a template ID (UUID)');
		expect(calls).toHaveLength(0);
	});

	it('fails at once on a concurrent-batch 429 with the API detail (AC6.14)', async () => {
		const detail = 'Concurrent batch limit exceeded';
		const { result, calls } = run(
			[
				account(400),
				{
					statusCode: 429,
					headers: { 'retry-after': '5' },
					body: problem(429, 'BATCH_RATE_LIMIT_EXCEEDED', detail),
				},
			],
			submitParameters(),
			{ items },
		);
		expect((await failureOf(result)).message).toBe(detail);
		expect(calls).toHaveLength(2);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('fails at once on a batch quota refusal with the quota message (AC6.14, AC2.7)', async () => {
		const { result } = run(
			[
				account(400),
				{
					statusCode: 429,
					headers: { 'x-quota-reset': '2026-12-01T00:00:00Z' },
					body: problem(429, 'BATCH_RATE_LIMIT_EXCEEDED', 'Monthly render quota exceeded'),
				},
			],
			submitParameters(),
			{ items },
		);
		expect((await failureOf(result)).message).toBe(
			'Monthly render quota used up; it resets on 2026-12-01. Upgrade at app.zandovi.com/plans.',
		);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('names Batch Job → Submit when the key lacks a scope (AC6.15)', async () => {
		const { result } = run(
			[
				account(400),
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'Missing scope', {
						details: { requiredScope: 'render' },
					}),
				},
			],
			submitParameters(),
			{ items },
		);
		expect((await failureOf(result)).message).toBe(
			'This API key lacks the `render` scope needed for Batch Job → Submit; create a key that has it',
		);
	});

	it('shows the API detail when the callback URL is refused (E25)', async () => {
		const detail = 'callbackUrl must be a publicly reachable https URL';
		const { result } = run(
			[account(400), { statusCode: 400, body: problem(400, 'VALIDATION_ERROR', detail) }],
			submitParameters({ options: { callbackUrl: 'http://localhost:5678/webhook-waiting/1' } }),
			{ items },
		);
		const error = await failureOf(result);
		expect(error.message).toBe(detail);
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	it('with Continue On Fail, turns a failed submit into one error item paired to all inputs', async () => {
		const { result } = run([account(2)], submitParameters(), { items, continueOnFail: true });
		const [output] = await result;
		expect(output).toEqual([
			{
				json: {
					error:
						"3 items exceed your plan's limit of 2 rows per batch job. Put a Loop Over Items node with batch size 2 before this node.",
					status: null,
					code: null,
				},
				pairedItem: allPaired,
			},
		]);
	});
});

describe('Batch Job → Submit with Wait for Completion (AC6.5, AC6.6, E30, E31)', () => {
	const waiting = submitParameters({ waitForCompletion: true, timeoutMinutes: 10 });

	it('polls the job every 5 s and outputs the final body of a COMPLETED job with failed rows', async () => {
		const done = job('COMPLETED', { downloadUrl: 'https://s3.example/batch.zip' });
		const { result, calls } = run(
			[account(400), submitted, polled('PENDING'), polled('PROCESSING'), polled('COMPLETED', done)],
			waiting,
			{ items },
		);
		const [output] = await result;
		expect(output).toEqual([{ json: done, pairedItem: allPaired }]);
		expect(calls.slice(2).map((call) => [call.method, call.url])).toEqual([
			['GET', `${API}/batch-jobs/${JOB_ID}`],
			['GET', `${API}/batch-jobs/${JOB_ID}`],
			['GET', `${API}/batch-jobs/${JOB_ID}`],
		]);
		expect(vi.mocked(sleep).mock.calls.map((call) => call[0])).toEqual([5000, 5000, 5000]);
	});

	it('outputs a CANCELLED job', async () => {
		const { result } = run([account(400), submitted, polled('CANCELLED')], waiting, { items });
		const [output] = await result;
		expect(output).toEqual([{ json: job('CANCELLED'), pairedItem: allPaired }]);
	});

	it('raises "Batch job <id> failed: <detail>" for a FAILED job', async () => {
		const failed = polled('FAILED', {
			failedItems: 3,
			errors: [
				{ itemIndex: 0, error: 'Font not found' },
				{ itemIndex: 2, error: 'Image unreachable' },
			],
		});
		const { result } = run([account(400), submitted, failed], waiting, { items });
		expect((await failureOf(result)).message).toBe(
			`Batch job ${JOB_ID} failed: row 0: Font not found; row 2: Image unreachable`,
		);
	});

	it('names the failed row count when a FAILED job lists no errors', async () => {
		const { result } = run(
			[account(400), submitted, polled('FAILED', { failedItems: 3 })],
			waiting,
			{ items },
		);
		expect((await failureOf(result)).message).toBe(
			`Batch job ${JOB_ID} failed: 3 of 3 rows failed`,
		);
	});

	it('with Continue On Fail, yields one error item for a FAILED job (AC2.10)', async () => {
		const { result } = run(
			[account(400), submitted, polled('FAILED', { failedItems: 3 })],
			waiting,
			{ items, continueOnFail: true },
		);
		const [output] = await result;
		expect(output).toEqual([
			{
				json: {
					error: `Batch job ${JOB_ID} failed: 3 of 3 rows failed`,
					status: null,
					code: 'BATCH_JOB_FAILED',
				},
				pairedItem: allPaired,
			},
		]);
	});

	it('fails after the timeout with the job id and status, and does not cancel the job (AC6.6)', async () => {
		let clock = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
		vi.mocked(sleep).mockImplementation(async (ms: number) => {
			clock += ms;
		});
		const replies = [account(400), submitted, ...Array.from({ length: 20 }, () => polled('PROCESSING'))];
		const { result, calls } = run(replies, submitParameters({ waitForCompletion: true, timeoutMinutes: 1 }), {
			items,
		});
		expect((await failureOf(result)).message).toBe(
			`Batch job ${JOB_ID} is still PROCESSING after 1 min. It keeps running; check it later with Batch Job → Get, or use a Callback URL with a Wait node.`,
		);
		const polls = calls.slice(2);
		expect(polls).toHaveLength(12);
		expect(polls.every((call) => call.method === 'GET' && call.url === `${API}/batch-jobs/${JOB_ID}`)).toBe(
			true,
		);
	});

	it('stops polling when the execution is cancelled, leaving the job running (E30)', async () => {
		const controller = new AbortController();
		vi.mocked(sleep).mockImplementation(async (_ms: number, signal?: AbortSignal) => {
			controller.abort();
			if (signal?.aborted) throw new Error('aborted');
		});
		const fake = createContext({
			replies: [account(400), submitted, polled('PROCESSING'), polled('PROCESSING')],
			parameters: waiting,
			items,
			executionId: 'exec-1',
		});
		Object.assign(fake.context, { getExecutionCancelSignal: () => controller.signal });
		const error = await failureOf(executeItems.call(fake.context, [batchJobResource]));
		expect(error.message).toBe(
			`The execution was cancelled; batch job ${JOB_ID} keeps running`,
		);
		expect(vi.mocked(sleep).mock.calls[0][1]).toBe(controller.signal);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls.some((call) => String(call.url).endsWith('/cancel'))).toBe(false);
	});

	it('gets a finished job at once when the submit replays it', async () => {
		const { result } = run(
			[account(400), { statusCode: 202, body: { jobId: JOB_ID, status: 'COMPLETED' } }, polled('COMPLETED')],
			waiting,
			{ items },
		);
		const [output] = await result;
		expect(output).toEqual([{ json: job('COMPLETED'), pairedItem: allPaired }]);
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe('Batch Job → Get, Get Items, Get Result, Cancel', () => {
	const jobParameters = (operation: string, overrides: IDataObject = {}) => ({
		resource: 'batchJob',
		operation,
		jobId: JOB_ID,
		...overrides,
	});

	it('Get outputs GET /batch-jobs/{id} (AC6.9)', async () => {
		const { result, calls } = run([polled('PROCESSING')], jobParameters('get'));
		const [output] = await result;
		expect(output).toEqual([{ json: job('PROCESSING'), pairedItem: { item: 0 } }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/batch-jobs/${JOB_ID}` });
	});

	it('Get reports a missing job as a batch job (AC2.9) and names the operation on a missing scope (AC6.15)', async () => {
		const missing = run(
			[{ statusCode: 404, body: problem(404, 'NOT_FOUND', 'gone') }],
			jobParameters('get'),
		);
		expect((await failureOf(missing.result)).message).toBe(
			"Batch job not found, or not visible to this API key's account",
		);
		const scope = run(
			[
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'Missing scope', {
						details: { requiredScope: 'render' },
					}),
				},
			],
			jobParameters('cancel'),
		);
		expect((await failureOf(scope.result)).message).toBe(
			'This API key lacks the `render` scope needed for Batch Job → Cancel; create a key that has it',
		);
	});

	const row = (rowIndex: number) => ({
		rowIndex,
		filename: `image-${rowIndex}.png`,
		size: rowIndex === 1 ? 0 : 1000,
		status: rowIndex === 1 ? 'FAILED' : 'COMPLETED',
		error: rowIndex === 1 ? 'Font not found' : null,
	});
	const itemsPage = (page: number, totalPages: number, rows: number[]): FakeReply => ({
		statusCode: 200,
		body: {
			data: rows.map(row),
			pagination: { page, size: 100, totalElements: 0, totalPages },
		},
	});

	it('Get Items pages through /items 100 at a time and outputs one item per row (AC6.10)', async () => {
		const { result, calls } = run(
			[itemsPage(0, 2, [0, 1]), itemsPage(1, 2, [2])],
			jobParameters('getItems', { returnAll: true }),
		);
		const [output] = await result;
		expect(output).toEqual([
			{ json: row(0), pairedItem: { item: 0 } },
			{ json: row(1), pairedItem: { item: 0 } },
			{ json: row(2), pairedItem: { item: 0 } },
		]);
		expect(calls.map((call) => [call.url, call.qs])).toEqual([
			[`${API}/batch-jobs/${JOB_ID}/items`, { page: 0, limit: 100 }],
			[`${API}/batch-jobs/${JOB_ID}/items`, { page: 1, limit: 100 }],
		]);
	});

	it('Get Items with Return All off stops at Limit', async () => {
		const { result, calls } = run(
			[itemsPage(0, 3, [0, 1, 2])],
			jobParameters('getItems', { returnAll: false, limit: 2 }),
		);
		const [output] = await result;
		expect(output.map((item) => item.json)).toEqual([row(0), row(1)]);
		expect(calls).toHaveLength(1);
	});

	it('Get Result outputs { url, expiresAt } from delivery=url (AC6.11)', async () => {
		const { result, calls } = run(
			[
				{
					statusCode: 200,
					body: { downloadUrl: 'https://s3.example/batch.zip?sig', expiresAt: '2026-11-05T11:00:00Z' },
				},
			],
			jobParameters('getResult'),
		);
		const [output] = await result;
		expect(output).toEqual([
			{
				json: { url: 'https://s3.example/batch.zip?sig', expiresAt: '2026-11-05T11:00:00Z' },
				pairedItem: { item: 0 },
			},
		]);
		expect(calls[0]).toMatchObject({
			method: 'GET',
			url: `${API}/batch-jobs/${JOB_ID}/result`,
			qs: { delivery: 'url' },
		});
	});

	it('Get Result never asks for the archive itself, even when an old workflow still sets the option', async () => {
		const { result, calls, prepareBinaryData } = run(
			[{ statusCode: 200, body: { downloadUrl: 'https://s3.example/b.zip', expiresAt: 'x' } }],
			jobParameters('getResult', { options: { downloadAsBinary: true } }),
		);
		const [[item]] = await result;
		expect(calls[0]).toMatchObject({ qs: { delivery: 'url' }, json: true });
		expect(calls[0]).not.toHaveProperty('encoding');
		expect(prepareBinaryData).not.toHaveBeenCalled();
		expect(item.binary).toBeUndefined();
	});

	it('Get Result on an unfinished job reads the job and says it has not finished yet (AC6.12, D-T12.3)', async () => {
		const body = problem(409, 'BATCH_RESULT_NOT_READY', 'Batch job is not completed yet');
		for (const status of ['PENDING', 'PROCESSING']) {
			const { result, calls } = run(
				[{ statusCode: 409, body }, polled(status)],
				jobParameters('getResult'),
			);
			const error = await failureOf(result);
			expect(error.message).toBe(`Batch job ${JOB_ID} has not finished yet`);
			expect(calls.map((call) => [call.method, call.url])).toEqual([
				['GET', `${API}/batch-jobs/${JOB_ID}/result`],
				['GET', `${API}/batch-jobs/${JOB_ID}`],
			]);
		}
	});

	it('Get Result on a job that ended FAILED or CANCELLED says it has no result (D-T12.3)', async () => {
		const body = problem(409, 'BATCH_RESULT_NOT_READY', 'Batch job is not completed yet');
		for (const status of ['FAILED', 'CANCELLED']) {
			const { result, calls } = run(
				[{ statusCode: 409, body }, polled(status)],
				jobParameters('getResult'),
			);
			const error = await failureOf(result);
			expect(error.message).toBe(`Batch job ${JOB_ID} ended ${status} and has no result`);
			expect(calls[1]).toMatchObject({ method: 'GET', url: `${API}/batch-jobs/${JOB_ID}` });
		}
	});

	it('Get Result reports a FAILED job as an error item when Continue On Fail is on (D-T12.3)', async () => {
		const { result } = run(
			[
				{ statusCode: 409, body: problem(409, 'BATCH_RESULT_NOT_READY', 'not completed') },
				polled('FAILED'),
			],
			jobParameters('getResult'),
			{ continueOnFail: true },
		);
		const [[item]] = await result;
		expect(item.json).toMatchObject({
			error: `Batch job ${JOB_ID} ended FAILED and has no result`,
		});
	});

	it('Cancel posts /cancel and outputs the job as it stands after the cancel (AC6.13)', async () => {
		const cancelled = job('CANCELLED', { completedItems: 1, processedItems: 1 });
		const { result, calls } = run(
			[{ statusCode: 204, body: '' }, { statusCode: 200, body: cancelled }],
			jobParameters('cancel'),
		);
		const [output] = await result;
		expect(calls.map((call) => [call.method, call.url])).toEqual([
			['POST', `${API}/batch-jobs/${JOB_ID}/cancel`],
			['GET', `${API}/batch-jobs/${JOB_ID}`],
		]);
		expect(output).toEqual([
			{ json: { ...cancelled, refundedRows: 2 }, pairedItem: { item: 0 } },
		]);
	});
});
