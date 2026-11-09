import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { getProjects, projectProperty } from '../../shared/templateLocator';
import { failureOf, zandoviError } from '../../transport/errors';
import {
	apiUrl,
	BASE_URL_MESSAGE,
	isAllowedBaseUrl,
	REQUEST_TIMEOUT_MS,
	userAgent,
	zandoviRequest,
} from '../../transport/request';

export const REUSE_HINT = 'Reuse Existing Copy avoids creating duplicates';

const LIMIT_CODES = ['PROJECT_TEMPLATE_LIMIT', 'PROJECT_LIMIT'];

interface LibraryEntry {
	id: string;
	name: string;
	variableCount?: number;
}

/**
 * The library index URL, built on the request layer's base URL so that it follows the same
 * normalisation as every API request.
 */
export function libraryIndexUrl(baseUrl: string | undefined): string {
	return `${apiUrl(baseUrl, '').replace(/\/api\/v1$/, '')}/library/index.json`;
}

/**
 * Reads the public library index. It is a static file that needs no authentication, so it is
 * fetched with the plain helper: the API key is not sent to the static file server.
 */
async function fetchLibraryIndex(
	this: ILoadOptionsFunctions,
	url: string,
): Promise<{ statusCode: number; body: unknown }> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url,
		headers: { 'User-Agent': userAgent() },
		timeout: REQUEST_TIMEOUT_MS,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	return (await this.helpers.httpRequest(options)) as { statusCode: number; body: unknown };
}

/** The label of the Project entry that leaves Project empty. */
export const DEFAULT_PROJECT_OPTION = 'Default (Your Oldest Project)';

/**
 * The Project dropdown of Create From Library: an explicit empty entry first, then every project
 * the key can see. n8n flags a value that is not one of the options, so without that entry the
 * documented default (empty) showed as an issue and blocked publishing the workflow.
 */
export async function getLibraryProjects(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return [{ name: DEFAULT_PROJECT_OPTION, value: '' }, ...(await getProjects.call(this))];
}

/** The library templates that bind variables, in index order, for the Library Template dropdown. */
export async function getLibraryTemplates(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials<{ baseUrl?: string }>('zandoviApi');
	if (!isAllowedBaseUrl(credentials.baseUrl)) {
		throw new NodeOperationError(this.getNode(), BASE_URL_MESSAGE);
	}
	const baseUrl = apiUrl(credentials.baseUrl, '').replace(/\/api\/v1$/, '');
	const failure = new NodeOperationError(
		this.getNode(),
		`Could not load the Zandovi template library from ${baseUrl}`,
	);
	let response: { statusCode: number; body: unknown };
	try {
		response = await fetchLibraryIndex.call(this, libraryIndexUrl(credentials.baseUrl));
	} catch {
		throw failure;
	}
	const templates = (response.body as { templates?: LibraryEntry[] } | undefined)?.templates;
	if (response.statusCode !== 200 || !Array.isArray(templates)) throw failure;
	return templates
		.filter((entry) => (entry.variableCount ?? 0) > 0)
		.map((entry) => ({
			name: `${entry.name} (${entry.variableCount} ${entry.variableCount === 1 ? 'variable' : 'variables'})`,
			value: entry.id,
		}));
}

async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const libraryId = this.getNodeParameter('libraryTemplateId', itemIndex) as string;
	const projectId = this.getNodeParameter('projectId', itemIndex, '') as string;
	const reuseExisting = this.getNodeParameter('reuseExisting', itemIndex, true) as boolean;

	const body: IDataObject = { fromLibrary: libraryId, reuseExisting };
	if (projectId) body.projectId = projectId;

	try {
		const response = await zandoviRequest.call(this, {
			method: 'POST',
			path: '/templates',
			body,
			resource: 'Library template',
			operation: 'Template → Create From Library',
		});
		return [{ json: { ...(response.body as IDataObject), reused: response.statusCode === 200 } }];
	} catch (caught) {
		const failure = failureOf(caught as Error);
		if (failure.code === 'LIBRARY_TEMPLATE_NOT_FOUND') {
			failure.message = `No library template with id ${libraryId}`;
		} else if (failure.code === 'FORBIDDEN') {
			// The API refuses a project the caller did not create; the project list cannot tell them apart.
			failure.message = `Project ${projectId} is not one of your own projects (another member shared it with you, or it does not exist). Create From Library can only add templates to projects you created: choose one of your own projects, or leave Project empty`;
		} else if (failure.code !== null && LIMIT_CODES.includes(failure.code)) {
			failure.message = `${failure.message.replace(/\.?$/, '.')} ${REUSE_HINT}`;
		}
		throw zandoviError(this.getNode(), failure);
	}
}

export const createFromLibraryOperation: ZandoviOperation = {
	value: 'createFromLibrary',
	name: 'Create From Library',
	action: 'Create a template from the library',
	description: 'Copy a Zandovi starter template that has variables into your account',
	properties: [
		{
			displayName: 'Library Template Name or ID',
			name: 'libraryTemplateId',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getLibraryTemplates' },
			default: '',
			required: true,
			description:
				'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		},
		{
			...projectProperty,
			typeOptions: { loadOptionsMethod: 'getLibraryProjects' },
			description:
				'The project that receives the copy, or empty for your oldest project; it must be one of your own projects, as a project shared with you by another member is refused; choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		},
		{
			displayName: 'Reuse Existing Copy',
			name: 'reuseExisting',
			type: 'boolean',
			default: true,
			description:
				'Whether to return the copy you already have instead of creating another one',
		},
	],
	execute,
};
