import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { isLastPage, listPage, projectProperty } from '../../shared/templateLocator';

async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const projectId = this.getNodeParameter('projectId', itemIndex) as string;
	const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex) as number);

	const templates: IDataObject[] = [];
	for (let page = 0; templates.length < limit; page++) {
		const result = await listPage.call(
			this,
			`/projects/${encodeURIComponent(projectId)}/templates`,
			page,
			{
				resource: 'Project',
				operation: 'Template → Get Many',
			},
		);
		templates.push(...result.data);
		if (isLastPage(result)) break;
	}
	return templates.slice(0, limit).map((template) => ({ json: template }));
}

export const getManyOperation: ZandoviOperation = {
	value: 'getAll',
	name: 'Get Many',
	action: 'Get many templates',
	description: 'List the templates in one Zandovi project',
	properties: [
		{ ...projectProperty, required: true },
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 500 },
			default: 50,
			displayOptions: { show: { returnAll: [false] } },
			description: 'Max number of results to return',
		},
	],
	execute,
};
