import { createHash } from 'crypto';
import type { IDataObject, INodeProperties, NodeApiError } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import { templateResource } from '../nodes/Zandovi/resources/template';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import packageJson from '../package.json';
import binaryRequest from './fixtures/generate-request-binary.json';
import linkRequest from './fixtures/generate-request-link.json';
import generateHeaders from './fixtures/generate-response-headers.json';
import templateDetail from './fixtures/template-detail.json';
import { LEAK_SENTINEL, createContext, problem } from './helpers/context';
import type { FakeContextOptions, FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const TEMPLATE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const GENERATE_URL = `https://app.zandovi.com/api/v1/templates/${TEMPLATE_ID}/generate`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const USER_AGENT = `zandovi-n8n/${packageJson.version}`;

const keyFor = (workflowId: string, executionId: string, itemIndex: number, runIndex = 0) =>
	`n8n-${createHash('sha256').update(`${workflowId}:${executionId}:Zandovi:${runIndex}:${itemIndex}`).digest('hex')}`;

const shareLink = {
	id: '9d1c3c55-1f2a-4b7e-9c1d-2e3f4a5b6c7d',
	url: 'https://share.zandovi.com/s/9d1c3c55.png',
	templateId: TEMPLATE_ID,
	templateName: 'Summer Sale Coupon',
	mimeType: 'image/png',
	fileSize: 48213,
	source: 'API',
	createdAt: '2026-11-05T10:00:00Z',
	expiresAt: '2026-11-12T10:00:00Z',
	fileName: 'summer-sale-coupon-3f9a2c.png',
};

function generateParameters(overrides: IDataObject = {}) {
	const parameters: IDataObject = {
		resource: 'template',
		operation: 'generate',
		templateId: { __rl: true, mode: 'id', value: TEMPLATE_ID },
		variables: {
			mappingMode: 'defineBelow',
			value: { customer_name: 'John Doe', discount_code: 'SAVE20' },
			matchingColumns: [],
			schema: [],
		},
		delivery: 'binary',
		format: 'png',
		binaryPropertyName: 'data',
		options: {},
		...overrides,
	};
	return parameters;
}

const binaryReply = (headers: IDataObject = generateHeaders, body: Buffer = PNG): FakeReply => ({
	statusCode: 200,
	headers,
	body,
});

function run(
	replies: FakeReply[],
	parameters: IDataObject | FakeContextOptions['parameters'],
	extra: Partial<FakeContextOptions> = {},
) {
	const fake = createContext({ replies, parameters, executionId: 'exec-1', ...extra });
	return { ...fake, result: executeItems.call(fake.context, [templateResource]) };
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
});

describe('Template resource fields (AC3.1, AC4.1, AC4.2, AC2.13)', () => {
	const properties = new Zandovi().description.properties;
	const field = (name: string, operation: string) =>
		properties.find(
			(property) =>
				property.name === name &&
				property.displayOptions?.show?.resource?.includes('template') &&
				property.displayOptions?.show?.operation?.includes(operation),
		) as INodeProperties;

	it('registers Template with Generate, Get, Get Many and Create From Library', () => {
		const resource = properties.find((property) => property.name === 'resource');
		expect(resource?.options).toContainEqual(expect.objectContaining({ value: 'template' }));
		const operation = properties.find(
			(property) =>
				property.name === 'operation' &&
				property.displayOptions?.show?.resource?.includes('template'),
		);
		expect((operation?.options as Array<{ value: string }>).map((option) => option.value)).toEqual([
			'generate',
			'get',
			'getAll',
			'createFromLibrary',
		]);
		expect(operation?.options).toContainEqual(
			expect.objectContaining({
				value: 'generate',
				description: 'Render a Zandovi template with variable values and return the image file',
			}),
		);
	});

	it('gives Generate a Template locator, Variables mapper, Delivery, Format, output field and Options', () => {
		expect(field('templateId', 'generate')).toMatchObject({ type: 'resourceLocator' });
		expect(field('variables', 'generate')).toMatchObject({ type: 'resourceMapper' });
		expect(field('delivery', 'generate')).toMatchObject({
			displayName: 'Delivery',
			type: 'options',
			default: 'binary',
			options: [
				expect.objectContaining({ name: 'Binary File', value: 'binary' }),
				expect.objectContaining({ name: 'Share Link', value: 'link' }),
			],
		});
		expect(field('format', 'generate')).toMatchObject({
			displayName: 'Format',
			type: 'options',
			default: 'png',
			options: [
				expect.objectContaining({ name: 'PNG', value: 'png' }),
				expect.objectContaining({ name: 'JPEG', value: 'jpeg' }),
				expect.objectContaining({ name: 'WebP', value: 'webp' }),
				expect.objectContaining({ name: 'PDF', value: 'pdf' }),
			],
		});
		expect(field('binaryPropertyName', 'generate')).toMatchObject({
			displayName: 'Put Output File in Field',
			default: 'data',
			displayOptions: { show: { delivery: ['binary'] } },
		});
		expect(field('options', 'generate')).toMatchObject({ type: 'collection' });
	});

	it('has the options of AC3.10, Quality only for JPEG and WebP and Link Expiry only for Share Link', () => {
		const options = field('options', 'generate').options as INodeProperties[];
		const option = (name: string) => options.find((candidate) => candidate.name === name);
		expect(options.map((candidate) => candidate.displayName).sort()).toEqual(
			[
				'Background Color',
				'File Name',
				'Idempotency Key',
				'Link Expiry (Days)',
				'Output DPI',
				'Quality',
				'Scale',
			].sort(),
		);
		expect(option('outputDpi')?.options).toEqual([
			expect.objectContaining({ name: 'Screen (96)', value: 96 }),
			expect.objectContaining({ name: 'Draft (150)', value: 150 }),
			expect.objectContaining({ name: 'Print (300)', value: 300 }),
		]);
		expect(option('scale')?.typeOptions).toMatchObject({ minValue: 1, maxValue: 4 });
		expect(option('quality')).toMatchObject({
			typeOptions: { minValue: 1, maxValue: 100 },
			displayOptions: { show: { '/format': ['jpeg', 'webp'] } },
		});
		expect(option('expiresInDays')?.displayOptions).toEqual({ show: { '/delivery': ['link'] } });
	});

	it('gives Get the same locator and Get Many a required Project, Return All and Limit', () => {
		const withoutOperation = (property: INodeProperties) => ({
			...property,
			displayOptions: undefined,
		});
		expect(withoutOperation(field('templateId', 'get'))).toEqual(
			withoutOperation(field('templateId', 'generate')),
		);
		expect(field('projectId', 'get')?.displayOptions?.show?.['templateId.mode']).toEqual(['list']);
		expect(field('projectId', 'getAll')).toMatchObject({ type: 'options', required: true });
		expect(field('returnAll', 'getAll')).toMatchObject({ type: 'boolean', default: false });
		expect(field('limit', 'getAll')).toMatchObject({
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1, maxValue: 500 },
			displayOptions: { show: { returnAll: [false] } },
		});
	});

	it('registers the locator, project and variables methods on the node', () => {
		const { methods } = new Zandovi();
		expect(Object.keys(methods?.loadOptions ?? {})).toEqual([
			'getProjects',
			'getLibraryProjects',
			'getLibraryTemplates',
		]);
		expect(Object.keys(methods?.listSearch ?? {})).toEqual(['searchTemplates']);
		expect(Object.keys(methods?.resourceMapping ?? {})).toEqual(['getTemplateVariables']);
	});
});

describe('Template → Generate, binary delivery (AC3.6, AC3.8, AC3.11)', () => {
	it('sends the exact request and outputs the file with its metadata', async () => {
		const { result, calls, prepareBinaryData } = run(
			[binaryReply()],
			generateParameters({ options: { fileName: 'coupon-SAVE20' } }),
		);
		const [output] = await result;
		expect(calls).toEqual([
			{
				method: 'POST',
				url: GENERATE_URL,
				headers: { 'Idempotency-Key': keyFor('wf-1', 'exec-1', 0), 'User-Agent': USER_AGENT },
				body: binaryRequest,
				encoding: 'arraybuffer',
				timeout: 120_000,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
			},
		]);
		expect(prepareBinaryData).toHaveBeenCalledWith(PNG, 'coupon-SAVE20.png', 'image/png');
		expect(output).toEqual([
			{
				json: {
					templateId: TEMPLATE_ID,
					fileName: 'coupon-SAVE20.png',
					mimeType: 'image/png',
					fileSize: PNG.length,
					format: 'png',
					unknownVariables: [],
					idempotencyReplayed: false,
					quotaRemaining: 987,
				},
				binary: {
					data: {
						data: PNG.toString('base64'),
						fileName: 'coupon-SAVE20.png',
						mimeType: 'image/png',
						fileSize: `${PNG.length} B`,
					},
				},
				pairedItem: { item: 0 },
			},
		]);
	});

	it('decodes filename* when present and falls back to filename', async () => {
		const { result } = run(
			[
				binaryReply({
					'content-type': 'application/pdf',
					'content-disposition':
						'attachment; filename="Faktura zolw.pdf"; filename*=UTF-8\'\'Faktura%20%C5%BC%C3%B3%C5%82w.pdf',
				}),
				binaryReply({
					'content-type': 'image/jpeg',
					'content-disposition': 'attachment; filename="summer-sale-coupon-3f9a2c.jpg"',
				}),
			],
			generateParameters({ format: 'pdf' }),
			{ items: [{ json: {} }, { json: {} }] },
		);
		const [output] = await result;
		expect(output.map((item) => [item.json.fileName, item.json.mimeType])).toEqual([
			['Faktura żółw.pdf', 'application/pdf'],
			['summer-sale-coupon-3f9a2c.jpg', 'image/jpeg'],
		]);
		expect(output[1].binary?.data.fileName).toBe('summer-sale-coupon-3f9a2c.jpg');
	});

	it('puts the file in the chosen field', async () => {
		const { result } = run([binaryReply()], generateParameters({ binaryPropertyName: 'coupon' }));
		const [[item]] = await result;
		expect(Object.keys(item.binary ?? {})).toEqual(['coupon']);
	});

	it('reports unknown variables, a replay and a missing quota header (AC3.7, AC3.8, E17)', async () => {
		const names = Array.from({ length: 20 }, (_, index) => `old_${index}`);
		const { result } = run(
			[
				binaryReply({
					'content-type': 'image/png',
					'content-disposition': 'attachment; filename="a.png"',
					'x-unknown-variables': ['caf%C3%A9', 'a%2Cb', ...names.slice(2)].join(','),
					'x-unknown-variables-total': '35',
					'idempotency-replayed': 'true',
				}),
			],
			generateParameters(),
		);
		const [[item]] = await result;
		expect(item.json.unknownVariables).toEqual(['café', 'a,b', ...names.slice(2)]);
		expect(item.json.unknownVariables).toHaveLength(20);
		expect(item.json.idempotencyReplayed).toBe(true);
		expect(item.json.quotaRemaining).toBeNull();
	});

	it('reports an empty or non-numeric quota header as null, not 0 (AC3.8)', async () => {
		for (const quota of ['', ' ', 'n/a']) {
			const { result } = run(
				[
					binaryReply({
						'content-type': 'image/png',
						'content-disposition': 'attachment; filename="a.png"',
						'x-quota-remaining': quota,
					}),
				],
				generateParameters(),
			);
			const [[item]] = await result;
			expect(item.json.quotaRemaining, JSON.stringify(quota)).toBeNull();
		}
	});

	it('sends every mapped value as a string and leaves empty ones out (AC3.6, D18)', async () => {
		const { result, calls } = run(
			[binaryReply()],
			generateParameters({
				variables: {
					mappingMode: 'defineBelow',
					value: { customer_name: 'Ana', seats: 3, vip: true, discount_code: '', note: null },
				},
			}),
		);
		await result;
		expect((calls[0].body as IDataObject).variables).toEqual({
			customer_name: 'Ana',
			seats: '3',
			vip: 'true',
		});
	});

	it('renders a template with no variables with an empty variables map (E10)', async () => {
		const { result, calls } = run(
			[binaryReply()],
			generateParameters({ variables: { mappingMode: 'defineBelow', value: null } }),
		);
		await result;
		expect(calls[0].body).toEqual({ variables: {}, format: 'png' });
	});
});

describe('Template → Generate, share link delivery (AC3.9)', () => {
	it('sends delivery link with the expiry and outputs the API body plus the header fields', async () => {
		const { result, calls } = run(
			[
				{
					statusCode: 200,
					headers: { 'content-type': 'application/json', 'x-quota-remaining': '12' },
					body: shareLink,
				},
			],
			generateParameters({
				delivery: 'link',
				variables: { mappingMode: 'defineBelow', value: linkRequest.variables },
				options: { expiresInDays: 7 },
			}),
		);
		const [output] = await result;
		expect(calls).toEqual([
			{
				method: 'POST',
				url: GENERATE_URL,
				headers: { 'Idempotency-Key': keyFor('wf-1', 'exec-1', 0), 'User-Agent': USER_AGENT },
				body: linkRequest,
				json: true,
				timeout: 120_000,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
			},
		]);
		expect(output).toEqual([
			{
				json: {
					...shareLink,
					templateId: TEMPLATE_ID,
					unknownVariables: [],
					idempotencyReplayed: false,
					quotaRemaining: 12,
				},
				pairedItem: { item: 0 },
			},
		]);
	});
});

describe('Template → Generate options (AC3.10, AC3.13)', () => {
	it('sends File Name, Output DPI, Quality and Background Color', async () => {
		const { result, calls } = run(
			[binaryReply()],
			generateParameters({
				format: 'jpeg',
				options: {
					fileName: 'Invoice 2026-001',
					outputDpi: 300,
					quality: 80,
					backgroundColor: '#ffffff',
				},
			}),
		);
		await result;
		expect(calls[0].body).toEqual({
			variables: { customer_name: 'John Doe', discount_code: 'SAVE20' },
			format: 'jpeg',
			filename: 'Invoice 2026-001',
			options: { outputDpi: 300, quality: 80, backgroundColor: '#ffffff' },
		});
	});

	it('sends Scale, and drops Quality for PNG and Link Expiry for binary delivery', async () => {
		const { result, calls } = run(
			[binaryReply()],
			generateParameters({ options: { scale: 2, quality: 80, expiresInDays: 7 } }),
		);
		await result;
		expect(calls[0].body).toEqual({
			variables: { customer_name: 'John Doe', discount_code: 'SAVE20' },
			format: 'png',
			options: { scale: 2 },
		});
	});

	it('fails before the request when both Output DPI and Scale are set', async () => {
		const { result, calls } = run(
			[],
			generateParameters({ options: { outputDpi: 150, scale: 2 } }),
		);
		const error = await failureOf(result);
		expect(error.message).toBe('Use either Output DPI or Scale, not both');
		expect(calls).toHaveLength(0);
	});

	it('sends a non-empty Idempotency Key verbatim (AC3.13)', async () => {
		const { result, calls } = run(
			[binaryReply()],
			generateParameters({ options: { idempotencyKey: 'order-1234 ' } }),
		);
		await result;
		expect(calls[0].headers).toEqual({
			'Idempotency-Key': 'order-1234 ',
			'User-Agent': USER_AGENT,
		});
	});

	it('shows the API rejecting an invalid or reused key (AC3.13, AC2.9)', async () => {
		const invalid = run(
			[
				{
					statusCode: 400,
					body: problem(
						400,
						'INVALID_IDEMPOTENCY_KEY',
						'Idempotency-Key must be at most 255 visible ASCII characters',
					),
				},
			],
			generateParameters({ options: { idempotencyKey: 'x'.repeat(256) } }),
		);
		expect((await failureOf(invalid.result)).message).toBe(
			'Idempotency-Key must be at most 255 visible ASCII characters',
		);
		const reused = run(
			[{ statusCode: 422, body: problem(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused') }],
			generateParameters({ options: { idempotencyKey: 'order-1234' } }),
		);
		expect((await failureOf(reused.result)).message).toBe(
			'This Idempotency Key was already used with different inputs',
		);
	});
});

describe('Template → Generate idempotency (AC3.11, AC3.12, AC3.14, E14)', () => {
	it('sends no key when the execution id is not available', async () => {
		const { result, calls } = run([binaryReply()], generateParameters(), {
			executionId: undefined,
		});
		await result;
		expect(calls[0].headers).toEqual({ 'User-Agent': USER_AGENT });
	});

	it('Retry On Fail after a lost response resends the same key and outputs the replay', async () => {
		const timeout = Object.assign(new Error('timeout of 120000ms exceeded'), {
			code: 'ECONNABORTED',
		});
		const fake = createContext({
			replies: [
				{ throws: timeout },
				binaryReply({ ...generateHeaders, 'idempotency-replayed': 'true' }),
			],
			parameters: generateParameters(),
			executionId: 'exec-1',
		});
		// n8n's Retry On Fail runs the node again inside the same execution (A5).
		const first = await failureOf(executeItems.call(fake.context, [templateResource]));
		expect(first.message).toBe('Zandovi did not respond within 120 s');
		const [[item]] = await executeItems.call(fake.context, [templateResource]);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].headers).toEqual(fake.calls[0].headers);
		expect(item.json.idempotencyReplayed).toBe(true);
		expect(item.binary?.data.data).toBe(PNG.toString('base64'));
	});

	it('Retry On Fail with link delivery returns the same share URL', async () => {
		const fake = createContext({
			replies: [
				{ throws: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
				{ statusCode: 200, headers: { 'idempotency-replayed': 'true' }, body: shareLink },
			],
			parameters: generateParameters({ delivery: 'link' }),
			executionId: 'exec-1',
		});
		await failureOf(executeItems.call(fake.context, [templateResource]));
		const [[item]] = await executeItems.call(fake.context, [templateResource]);
		expect(fake.calls[1].headers).toEqual(fake.calls[0].headers);
		expect(item.json).toMatchObject({ url: shareLink.url, idempotencyReplayed: true });
	});

	it('waits out a still-running first attempt (409 in progress), with the same key (E14)', async () => {
		const { result, calls } = run(
			[
				{
					statusCode: 409,
					body: problem(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this key is in progress'),
				},
				binaryReply({ ...generateHeaders, 'idempotency-replayed': 'true' }),
			],
			generateParameters(),
		);
		const [[item]] = await result;
		expect(calls[1].headers).toEqual(calls[0].headers);
		expect(item.json.idempotencyReplayed).toBe(true);
	});

	it('a re-run execution gets a new execution id and so a new key (AC3.14)', async () => {
		const first = run([binaryReply()], generateParameters(), { executionId: 'exec-1' });
		const rerun = run([binaryReply()], generateParameters(), { executionId: 'exec-2' });
		await first.result;
		await rerun.result;
		expect(first.calls[0].headers?.['Idempotency-Key']).toBe(keyFor('wf-1', 'exec-1', 0));
		expect(rerun.calls[0].headers?.['Idempotency-Key']).toBe(keyFor('wf-1', 'exec-2', 0));
	});

	it('a second run of the node in one execution (Loop Over Items, agent call) gets a new key (AC3.11)', async () => {
		const run0 = run([binaryReply()], generateParameters(), { runIndex: 0 });
		const run1 = run([binaryReply()], generateParameters(), { runIndex: 1 });
		await run0.result;
		await run1.result;
		expect(run0.calls[0].headers?.['Idempotency-Key']).toBe(keyFor('wf-1', 'exec-1', 0, 0));
		expect(run1.calls[0].headers?.['Idempotency-Key']).toBe(keyFor('wf-1', 'exec-1', 0, 1));
		expect(run1.calls[0].headers?.['Idempotency-Key']).not.toBe(
			run0.calls[0].headers?.['Idempotency-Key'],
		);
	});

	it('Retry On Fail inside a later run keeps that run\'s key (A5)', async () => {
		const fake = createContext({
			replies: [
				{ throws: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
				binaryReply({ ...generateHeaders, 'idempotency-replayed': 'true' }),
			],
			parameters: generateParameters(),
			executionId: 'exec-1',
			runIndex: 2,
		});
		await failureOf(executeItems.call(fake.context, [templateResource]));
		await executeItems.call(fake.context, [templateResource]);
		expect(fake.calls.map((call) => call.headers?.['Idempotency-Key'])).toEqual([
			keyFor('wf-1', 'exec-1', 0, 2),
			keyFor('wf-1', 'exec-1', 0, 2),
		]);
	});

	it('sends no key without an execution id, whatever the run index', async () => {
		const { result, calls } = run([binaryReply()], generateParameters(), {
			executionId: undefined,
			runIndex: 1,
		});
		await result;
		expect(calls[0].headers).toEqual({ 'User-Agent': USER_AGENT });
	});
});

describe('Template → Generate items and errors (AC3.15, AC3.17, AC3.3, E11, E13, E16)', () => {
	it('turns N input items into N outputs in input order, each paired and keyed by its index', async () => {
		const names = ['Ana', 'Ben', 'Cy'];
		const { result, calls } = run(
			names.map((name) =>
				binaryReply({
					'content-type': 'image/png',
					'content-disposition': `attachment; filename="${name}.png"`,
				}),
			),
			(name: string, itemIndex: number) =>
				name === 'variables'
					? { mappingMode: 'defineBelow', value: { customer_name: names[itemIndex] } }
					: generateParameters()[name],
			{ items: names.map((name) => ({ json: { name } })) },
		);
		const [output] = await result;
		expect(output.map((item) => [item.json.fileName, item.pairedItem])).toEqual([
			['Ana.png', { item: 0 }],
			['Ben.png', { item: 1 }],
			['Cy.png', { item: 2 }],
		]);
		expect(calls.map((call) => (call.body as IDataObject).variables)).toEqual([
			{ customer_name: 'Ana' },
			{ customer_name: 'Ben' },
			{ customer_name: 'Cy' },
		]);
		expect(calls.map((call) => call.headers?.['Idempotency-Key'])).toEqual([
			keyFor('wf-1', 'exec-1', 0),
			keyFor('wf-1', 'exec-1', 1),
			keyFor('wf-1', 'exec-1', 2),
		]);
	});

	it('fails with the scope message when the key lacks render (AC3.17)', async () => {
		const { result } = run(
			[
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'Missing scope', {
						details: { requiredScope: 'render' },
					}),
				},
			],
			generateParameters(),
		);
		const error = await failureOf(result);
		expect(error.message).toBe(
			'This API key lacks the `render` scope needed for Template → Generate; create a key that has it',
		);
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});

	it('names a missing required variable from the API 400 (AC3.6)', async () => {
		const { result } = run(
			[
				{
					statusCode: 400,
					body: problem(400, 'VALIDATION_ERROR', 'Variable validation failed', {
						details: { customer_name: 'Required variable is missing' },
					}),
				},
			],
			generateParameters({ variables: { mappingMode: 'defineBelow', value: {} } }),
		);
		expect((await failureOf(result)).message).toBe(
			'Variable validation failed; customer_name: Required variable is missing',
		);
	});

	it('reports a deleted template as not found (E11)', async () => {
		const { result } = run(
			[{ statusCode: 404, body: problem(404, 'TEMPLATE_NOT_FOUND', 'Template not found') }],
			generateParameters(),
		);
		expect((await failureOf(result)).message).toBe(
			"Template not found, or not visible to this API key's account",
		);
	});

	it('adds the Upload hint to an unreachable image variable (E13)', async () => {
		const { result } = run(
			[
				{
					statusCode: 422,
					body: problem(
						422,
						'IMAGE_VARIABLE_UNREACHABLE',
						'The image for variable photo could not be downloaded.',
					),
				},
			],
			generateParameters(),
		);
		expect((await failureOf(result)).message).toBe(
			'The image for variable photo could not be downloaded. Upload it first with Image → Upload',
		);
	});

	it('fails at run time when the template ID expression resolved to a non-UUID (AC3.3)', async () => {
		const { result, calls } = run(
			[],
			generateParameters({ templateId: { __rl: true, mode: 'id', value: 'Summer Sale' } }),
		);
		const error = await failureOf(result);
		expect(error.message).toBe('Enter a template ID (UUID)');
		expect(error.context.itemIndex).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe('Template → Get (AC4.1)', () => {
	it('outputs the GET /templates/{id} body, variables included', async () => {
		const { result, calls } = run([{ statusCode: 200, body: templateDetail }], {
			resource: 'template',
			operation: 'get',
			templateId: { __rl: true, mode: 'list', value: TEMPLATE_ID },
		});
		expect(await result).toEqual([[{ json: templateDetail, pairedItem: { item: 0 } }]]);
		expect(calls).toEqual([
			{
				method: 'GET',
				url: `https://app.zandovi.com/api/v1/templates/${TEMPLATE_ID}`,
				headers: { 'User-Agent': USER_AGENT },
				json: true,
				timeout: 120_000,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
			},
		]);
	});
});

describe('Template → Get Many (AC4.2)', () => {
	const templates = (from: number, count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `t-${from + index}`,
			name: `T${from + index}`,
		}));
	const page = (data: IDataObject[], pageNumber: number, totalPages: number): FakeReply => ({
		statusCode: 200,
		body: { data, pagination: { page: pageNumber, size: 100, totalElements: 0, totalPages } },
	});
	const getMany = (returnAll: boolean, limit = 50) => ({
		resource: 'template',
		operation: 'getAll',
		projectId: PROJECT_ID,
		returnAll,
		limit,
	});
	const listUrl = `https://app.zandovi.com/api/v1/projects/${PROJECT_ID}/templates`;

	it('with Return All, pages with limit=100 to the last page and outputs one item per template', async () => {
		const { result, calls } = run(
			[
				page(templates(0, 100), 0, 3),
				page(templates(100, 100), 1, 3),
				page(templates(200, 5), 2, 3),
			],
			getMany(true),
		);
		const [output] = await result;
		expect(calls.map((call) => [call.method, call.url, call.qs])).toEqual([
			['GET', listUrl, { page: 0, limit: 100 }],
			['GET', listUrl, { page: 1, limit: 100 }],
			['GET', listUrl, { page: 2, limit: 100 }],
		]);
		expect(output).toHaveLength(205);
		expect(output[0]).toEqual({ json: { id: 't-0', name: 'T0' }, pairedItem: { item: 0 } });
		expect(output[204].json).toEqual({ id: 't-204', name: 'T204' });
	});

	it('without Return All, stops once Limit templates are collected', async () => {
		const { result, calls } = run(
			[page(templates(0, 100), 0, 5), page(templates(100, 100), 1, 5)],
			getMany(false, 150),
		);
		const [output] = await result;
		expect(calls).toHaveLength(2);
		expect(output).toHaveLength(150);
		expect(output[149].json.id).toBe('t-149');
	});

	it('reads one page for the default Limit of 50', async () => {
		const { result, calls } = run([page(templates(0, 100), 0, 2)], getMany(false));
		const [output] = await result;
		expect(calls).toHaveLength(1);
		expect(output).toHaveLength(50);
	});

	it('outputs nothing for an empty project', async () => {
		const { result } = run([page([], 0, 0)], getMany(true));
		expect(await result).toEqual([[]]);
	});
});
