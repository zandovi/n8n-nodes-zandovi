import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeProperties,
	NodeApiError,
} from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import { templateResource } from '../nodes/Zandovi/resources/template';
import {
	DEFAULT_PROJECT_OPTION,
	getLibraryProjects,
	getLibraryTemplates,
} from '../nodes/Zandovi/resources/template/createFromLibrary';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import { LEAK_SENTINEL, createContext, problem } from './helpers/context';
import type { FakeContextOptions, FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BASE = 'https://app.zandovi.com';
const INDEX = {
	categories: [{ id: 'coupons', label: 'Coupons', count: 2 }],
	templates: [
		{ id: 'coupon-starter-variables', name: 'Starter Coupon (Variables)', variableCount: 5 },
		{ id: 'plain-coupon', name: 'Plain Coupon', variableCount: 0 },
		{ id: 'legacy', name: 'No Count' },
		{ id: 'podcast-guest-spotlight', name: 'Guest Spotlight', variableCount: 1 },
		{ id: 'ticket-starter-variables', name: 'Starter Event Ticket (Variables)', variableCount: 7 },
	],
};
const created = { id: 'tpl-1', name: 'Starter Coupon (Variables)', projectId: PROJECT_ID };

function run(
	replies: FakeReply[],
	parameters: IDataObject,
	extra: Partial<FakeContextOptions> = {},
) {
	const fake = createContext({
		replies,
		parameters: {
			resource: 'template',
			operation: 'createFromLibrary',
			libraryTemplateId: 'coupon-starter-variables',
			projectId: '',
			reuseExisting: true,
			...parameters,
		},
		...extra,
	});
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

function loadLibrary(reply: FakeReply, baseUrl?: string) {
	const fake = createContext({ replies: [reply], baseUrl });
	return {
		...fake,
		result: getLibraryTemplates.call(fake.context as never),
	};
}

describe('Create From Library fields (AC4.3, AC4.4)', () => {
	const properties = new Zandovi().description.properties;
	const field = (name: string) =>
		properties.find(
			(property) =>
				property.name === name &&
				property.displayOptions?.show?.operation?.includes('createFromLibrary'),
		) as INodeProperties;

	it('has a library dropdown, an optional Project and Reuse Existing Copy on by default', () => {
		expect(field('libraryTemplateId')).toMatchObject({
			type: 'options',
			required: true,
			typeOptions: { loadOptionsMethod: 'getLibraryTemplates' },
		});
		expect(field('projectId').required).not.toBe(true);
		expect(field('projectId').typeOptions).toEqual({ loadOptionsMethod: 'getLibraryProjects' });
		expect(field('reuseExisting')).toMatchObject({
			displayName: 'Reuse Existing Copy',
			type: 'boolean',
			default: true,
		});
		expect(new Zandovi().methods.loadOptions).toHaveProperty('getLibraryTemplates');
		expect(new Zandovi().methods.loadOptions).toHaveProperty('getLibraryProjects');
	});

	// Found in a live n8n: an empty Project was not one of the options, so n8n flagged it
	// ("The value \"\" is not supported!") and would not publish the workflow.
	it('offers the empty default as the first Project entry, then every project', async () => {
		const fake = createContext({
			replies: [
				{
					statusCode: 200,
					body: {
						data: [
							{ id: 'p-1', name: 'Summer Campaign' },
							{ id: 'p-2', name: 'Shared by a teammate' },
						],
						pagination: { page: 0, totalPages: 1 },
					},
				},
			],
		});
		const options = await getLibraryProjects.call(
			fake.context as unknown as ILoadOptionsFunctions,
		);
		expect(options).toEqual([
			{ name: DEFAULT_PROJECT_OPTION, value: '' },
			{ name: 'Summer Campaign', value: 'p-1' },
			{ name: 'Shared by a teammate', value: 'p-2' },
		]);
		expect(field('projectId').default).toBe('');
	});

	it('says that a project shared by another member cannot receive the copy (D-T14.5)', () => {
		// The public project list has no owner field, so the dropdown cannot filter; the
		// description warns instead.
		expect(field('projectId').description).toMatch(/your own projects/);
		expect(field('projectId').description).toMatch(/shared .*another member.*refused/);
	});
});

describe('Library Template dropdown (AC4.3, AC4.6, E20)', () => {
	it('keeps variable entries in index order and labels them', async () => {
		const { result, calls } = loadLibrary({ statusCode: 200, body: INDEX });
		expect(await result).toEqual([
			{ name: 'Starter Coupon (Variables) (5 variables)', value: 'coupon-starter-variables' },
			{ name: 'Guest Spotlight (1 variable)', value: 'podcast-guest-spotlight' },
			{
				name: 'Starter Event Ticket (Variables) (7 variables)',
				value: 'ticket-starter-variables',
			},
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/library/index.json` });
	});

	it('reads the index from the credential Base URL', async () => {
		const { result, calls } = loadLibrary(
			{ statusCode: 200, body: INDEX },
			'https://dev.zandovi.example/',
		);
		await result;
		expect(calls[0]?.url).toBe('https://dev.zandovi.example/library/index.json');
	});

	it('fails with the library message on a non-200', async () => {
		const { result } = loadLibrary({ statusCode: 503, body: 'down' });
		await expect(result).rejects.toThrow(
			`Could not load the Zandovi template library from ${BASE}`,
		);
	});

	it('fails with the library message on a network error', async () => {
		const { result } = loadLibrary({ throws: new Error('getaddrinfo ENOTFOUND') }, 'https://x.test');
		await expect(result).rejects.toThrow(
			'Could not load the Zandovi template library from https://x.test',
		);
	});
});

describe('Template → Create From Library (AC4.4, AC4.5, E18, E19)', () => {
	it('omits projectId when empty, sends reuseExisting, and marks a 200 as reused', async () => {
		const { result, calls } = run([{ statusCode: 200, body: created }], {});
		expect(await result).toEqual([
			[{ json: { ...created, reused: true }, pairedItem: { item: 0 } }],
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: `${BASE}/api/v1/templates`,
			body: { fromLibrary: 'coupon-starter-variables', reuseExisting: true },
		});
		expect(calls[0]?.body).not.toHaveProperty('projectId');
	});

	it('marks a 201 as not reused and sends the chosen project and reuse off', async () => {
		const { result, calls } = run([{ statusCode: 201, body: created }], {
			projectId: PROJECT_ID,
			reuseExisting: false,
		});
		expect(await result).toEqual([
			[{ json: { ...created, reused: false }, pairedItem: { item: 0 } }],
		]);
		expect(calls[0]?.body).toEqual({
			fromLibrary: 'coupon-starter-variables',
			reuseExisting: false,
			projectId: PROJECT_ID,
		});
	});

	it('creates once, then reuses, across runs (E18, E19)', async () => {
		const replies: FakeReply[] = [
			{ statusCode: 201, body: created },
			{ statusCode: 200, body: created },
			{ statusCode: 200, body: created },
		];
		const outputs = [] as boolean[];
		const fake = createContext({
			replies,
			parameters: {
				resource: 'template',
				operation: 'createFromLibrary',
				libraryTemplateId: 'coupon-starter-variables',
				reuseExisting: true,
			},
			items: [{ json: {} }, { json: {} }, { json: {} }],
		});
		const [items] = await executeItems.call(fake.context, [templateResource]);
		for (const item of items ?? []) outputs.push(item.json.reused as boolean);
		expect(outputs).toEqual([false, true, true]);
	});
});

describe('Template → Create From Library errors (AC4.7, AC4.8, AC4.9)', () => {
	it('names the unknown library id', async () => {
		const { result } = run(
			[
				{
					statusCode: 404,
					body: problem(404, 'LIBRARY_TEMPLATE_NOT_FOUND', 'No library template with that id.'),
				},
			],
			{ libraryTemplateId: 'nope' },
		);
		const error = await failureOf(result);
		expect(error.message).toBe('No library template with id nope');
		expect(error.httpCode).toBe('404');
	});

	it.each(['PROJECT_TEMPLATE_LIMIT', 'PROJECT_LIMIT'])(
		'shows the API detail and the hint for %s',
		async (code) => {
			const detail = 'This project has reached its limit of 5 templates.';
			const { result } = run([{ statusCode: 400, body: problem(400, code, detail) }], {});
			const error = await failureOf(result);
			expect(error.message).toBe(`${detail} Reuse Existing Copy avoids creating duplicates`);
		},
	);

	it('names the cause when the project is not one of the caller\'s own (D-T14.5)', async () => {
		const { result, calls } = run(
			[
				{
					statusCode: 403,
					body: problem(403, 'FORBIDDEN', 'Only the project creator can add templates to this project.'),
				},
			],
			{ projectId: PROJECT_ID },
		);
		const error = await failureOf(result);
		expect(calls[0]?.body).toEqual({
			fromLibrary: 'coupon-starter-variables',
			reuseExisting: true,
			projectId: PROJECT_ID,
		});
		expect(error.message).toBe(
			`Project ${PROJECT_ID} is not one of your own projects (another member shared it with you, or it does not exist). Create From Library can only add templates to projects you created: choose one of your own projects, or leave Project empty`,
		);
		expect(error.httpCode).toBe('403');
	});

	it('names templates:write for a read-only key', async () => {
		const { result } = run(
			[
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'Missing scope', {
						details: { requiredScope: 'templates:write' },
					}),
				},
			],
			{},
		);
		const error = await failureOf(result);
		expect(error.message).toContain('`templates:write`');
		expect(error.message).toContain('Template → Create From Library');
		expect(JSON.stringify(error)).not.toContain(LEAK_SENTINEL);
	});
});
