import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { RequestLabels } from '../transport/errors';
import { zandoviRequest } from '../transport/request';

export const TEMPLATE_ID_MESSAGE = 'Enter a template ID (UUID)';
export const UUID_PATTERN =
	'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_REGEX = new RegExp(UUID_PATTERN);

/** The largest page the list endpoints serve. */
export const PAGE_SIZE = 100;

/** One page of a `page` + `limit` list endpoint. */
export interface ListPage {
	data: IDataObject[];
	pagination: { page: number; totalPages: number };
}

/** Reads page `page` (0-based) of a `page` + `limit` list endpoint, 100 items at a time. */
export async function listPage(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	path: string,
	page: number,
	labels: RequestLabels,
): Promise<ListPage> {
	const response = await zandoviRequest.call(this, {
		method: 'GET',
		path,
		qs: { page, limit: PAGE_SIZE },
		...labels,
	});
	return response.body as ListPage;
}

export function isLastPage(page: ListPage): boolean {
	return page.data.length === 0 || page.pagination.page + 1 >= page.pagination.totalPages;
}

/** Every project the key can see, for the Project dropdown. */
export async function getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const options: INodePropertyOptions[] = [];
	for (let page = 0; ; page++) {
		const result = await listPage.call(this, '/projects', page, {
			resource: 'Project',
			operation: 'listing projects',
		});
		for (const project of result.data)
			options.push({ name: String(project.name), value: String(project.id) });
		if (isLastPage(result)) return options;
	}
}

/**
 * The chosen project's templates for the Template locator, one API page per pagination token.
 * The API has no search parameter, so the filter matches names case-insensitively here; a page
 * with no match reads on, so the list is never empty while pages remain.
 */
export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const projectId = this.getNodeParameter('projectId', '') as string;
	if (!projectId) throw new NodeOperationError(this.getNode(), 'Choose a project first');
	const needle = filter?.toLowerCase() ?? '';
	for (let page = Number(paginationToken ?? 0); ; page++) {
		const result = await listPage.call(
			this,
			`/projects/${encodeURIComponent(projectId)}/templates`,
			page,
			{
				resource: 'Project',
				operation: 'listing templates',
			},
		);
		const results = result.data
			.filter((template) => String(template.name).toLowerCase().includes(needle))
			.map((template) => ({ name: String(template.name), value: String(template.id) }));
		if (isLastPage(result)) return { results };
		if (results.length > 0) return { results, paginationToken: String(page + 1) };
	}
}

/** The Project dropdown, without display rules. */
export const projectProperty: INodeProperties = {
	displayName: 'Project Name or ID',
	name: 'projectId',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getProjects' },
	default: '',
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
};

/** The Template locator: a project → template list, or a template ID. */
export const templateLocatorProperties: INodeProperties[] = [
	{
		...projectProperty,
		displayOptions: { show: { 'templateId.mode': ['list'] } },
	},
	{
		displayName: 'Template',
		name: 'templateId',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The Zandovi template to use, picked from the project or given by its ID',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6',
				validation: [
					{
						type: 'regex',
						properties: { regex: UUID_PATTERN, errorMessage: TEMPLATE_ID_MESSAGE },
					},
				],
			},
		],
	},
];

export function isUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

/** The Template locator's value for an item; a non-UUID (from an expression) fails here. */
export function templateIdOf(this: IExecuteFunctions, itemIndex: number): string {
	const value = String(this.getNodeParameter('templateId', itemIndex, '', { extractValue: true }));
	if (!isUuid(value)) {
		throw new NodeOperationError(this.getNode(), TEMPLATE_ID_MESSAGE, { itemIndex });
	}
	return value;
}
