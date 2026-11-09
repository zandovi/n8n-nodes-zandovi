import type { IDataObject, ILoadOptionsFunctions, INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import {
	getProjects,
	searchTemplates,
	templateIdOf,
	templateLocatorProperties,
} from '../nodes/Zandovi/shared/templateLocator';
import { createContext } from './helpers/context';
import type { FakeReply } from './helpers/context';

const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function page(data: IDataObject[], pageNumber: number, totalPages: number): FakeReply {
	return {
		statusCode: 200,
		body: {
			data,
			pagination: { page: pageNumber, size: 100, totalElements: data.length, totalPages },
		},
	};
}

const projects = (from: number, count: number) =>
	Array.from({ length: count }, (_, index) => ({
		id: `p-${from + index}`,
		name: `Project ${from + index}`,
	}));

function loadOptions(replies: FakeReply[], parameters: IDataObject = {}) {
	const fake = createContext({ replies, parameters });
	return { ...fake, context: fake.context as unknown as ILoadOptionsFunctions };
}

describe('getProjects (AC3.2)', () => {
	it('pages through GET /projects with limit=100 until the last page', async () => {
		const { context, calls } = loadOptions([
			page(projects(0, 100), 0, 3),
			page(projects(100, 100), 1, 3),
			page(projects(200, 7), 2, 3),
		]);
		const options = await getProjects.call(context);
		expect(calls.map((call) => [call.method, call.url, call.qs])).toEqual([
			['GET', 'https://app.zandovi.com/api/v1/projects', { page: 0, limit: 100 }],
			['GET', 'https://app.zandovi.com/api/v1/projects', { page: 1, limit: 100 }],
			['GET', 'https://app.zandovi.com/api/v1/projects', { page: 2, limit: 100 }],
		]);
		expect(options).toHaveLength(207);
		expect(options[0]).toEqual({ name: 'Project 0', value: 'p-0' });
		expect(options[206]).toEqual({ name: 'Project 206', value: 'p-206' });
	});

	it('returns an empty list when the key sees no project (AC3.18)', async () => {
		const { context, calls } = loadOptions([page([], 0, 0)]);
		await expect(getProjects.call(context)).resolves.toEqual([]);
		expect(calls).toHaveLength(1);
	});
});

describe('searchTemplates (AC3.2)', () => {
	const templates = [
		{ id: 't-1', name: 'Summer Sale Coupon' },
		{ id: 't-2', name: 'Winter ticket' },
		{ id: 't-3', name: 'COUPON for VIPs' },
	];

	it("lists the chosen project's templates one API page per pagination token", async () => {
		const { context, calls } = loadOptions([page(templates, 0, 2), page([templates[0]], 1, 2)], {
			projectId: PROJECT_ID,
		});
		const first = await searchTemplates.call(context);
		expect(first).toEqual({
			results: [
				{ name: 'Summer Sale Coupon', value: 't-1' },
				{ name: 'Winter ticket', value: 't-2' },
				{ name: 'COUPON for VIPs', value: 't-3' },
			],
			paginationToken: '1',
		});
		const second = await searchTemplates.call(context, undefined, first.paginationToken);
		expect(second).toEqual({ results: [{ name: 'Summer Sale Coupon', value: 't-1' }] });
		expect(calls.map((call) => [call.url, call.qs])).toEqual([
			[`https://app.zandovi.com/api/v1/projects/${PROJECT_ID}/templates`, { page: 0, limit: 100 }],
			[`https://app.zandovi.com/api/v1/projects/${PROJECT_ID}/templates`, { page: 1, limit: 100 }],
		]);
	});

	it('filters by template name, case-insensitive', async () => {
		const { context } = loadOptions([page(templates, 0, 1)], { projectId: PROJECT_ID });
		await expect(searchTemplates.call(context, 'coupon')).resolves.toEqual({
			results: [
				{ name: 'Summer Sale Coupon', value: 't-1' },
				{ name: 'COUPON for VIPs', value: 't-3' },
			],
		});
	});

	it('reads on past pages with no match, so a filtered page is never empty while more remain', async () => {
		const { context, calls } = loadOptions(
			[page([templates[1]], 0, 3), page([templates[2]], 1, 3), page([templates[0]], 2, 3)],
			{ projectId: PROJECT_ID },
		);
		await expect(searchTemplates.call(context, 'vip')).resolves.toEqual({
			results: [{ name: 'COUPON for VIPs', value: 't-3' }],
			paginationToken: '2',
		});
		expect(calls).toHaveLength(2);
	});

	it('asks for a project first when none is chosen', async () => {
		const { context, calls } = loadOptions([], { projectId: '' });
		await expect(searchTemplates.call(context)).rejects.toThrow('Choose a project first');
		expect(calls).toHaveLength(0);
	});
});

describe('Template locator fields (AC3.1, AC3.2, AC3.3)', () => {
	const byName = (name: string) =>
		templateLocatorProperties.find((property) => property.name === name) as INodeProperties;

	it('shows the Project dropdown in From List mode only, before the Template locator', () => {
		expect(templateLocatorProperties.map((property) => property.name)).toEqual([
			'projectId',
			'templateId',
		]);
		expect(byName('projectId')).toMatchObject({
			displayName: 'Project Name or ID',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getProjects' },
			displayOptions: { show: { 'templateId.mode': ['list'] } },
		});
	});

	it('has From List and By ID modes, By ID validated as a UUID', () => {
		const locator = byName('templateId');
		expect(locator).toMatchObject({
			displayName: 'Template',
			type: 'resourceLocator',
			required: true,
			default: { mode: 'list', value: '' },
		});
		const [list, byId] = locator.modes ?? [];
		expect(list).toMatchObject({
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
		});
		expect(byId).toMatchObject({ displayName: 'By ID', name: 'id', type: 'string' });
		const [rule] = (byId.validation ?? []) as Array<{
			type: string;
			properties: { regex: string; errorMessage: string };
		}>;
		expect(rule.type).toBe('regex');
		expect(rule.properties.errorMessage).toBe('Enter a template ID (UUID)');
		const regex = new RegExp(rule.properties.regex);
		expect(regex.test(UUID)).toBe(true);
		expect(regex.test(UUID.toUpperCase())).toBe(true);
		for (const bad of ['', 'abc', `${UUID}x`, `x${UUID}`, UUID.replace(/-/g, '')]) {
			expect(regex.test(bad), bad).toBe(false);
		}
	});
});

describe('templateIdOf (AC3.3)', () => {
	const run = (value: unknown) => {
		const { context } = createContext({ replies: [], parameters: { templateId: value } });
		return () => templateIdOf.call(context, 0);
	};

	it('returns the UUID from either mode', () => {
		expect(run({ __rl: true, mode: 'id', value: UUID })()).toBe(UUID);
		expect(run({ __rl: true, mode: 'list', value: UUID })()).toBe(UUID);
	});

	it('fails at run time with the editor message when an expression resolved to a non-UUID', () => {
		expect(run({ __rl: true, mode: 'id', value: 'Summer Sale Coupon' })).toThrow(
			'Enter a template ID (UUID)',
		);
		expect(run({ __rl: true, mode: 'id', value: '' })).toThrow('Enter a template ID (UUID)');
	});
});
