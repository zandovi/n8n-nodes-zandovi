import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { isLastPage, listPage } from '../../shared/templateLocator';
import { jobIdOf, jobIdProperty, jobPath } from './job';

async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const jobId = jobIdOf.call(this, itemIndex);
	const returnAll = this.getNodeParameter('returnAll', itemIndex, true) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);

	const rows: IDataObject[] = [];
	for (let page = 0; rows.length < limit; page++) {
		const result = await listPage.call(this, jobPath(jobId, '/items'), page, {
			resource: 'Batch job',
			operation: 'Batch Job → Get Items',
		});
		rows.push(...result.data);
		if (isLastPage(result)) break;
	}
	return rows.slice(0, limit).map((row) => ({ json: row }));
}

export const getItemsOperation: ZandoviOperation = {
	value: 'getItems',
	name: 'Get Items',
	action: 'Get the rows of a batch job',
	description: "List a batch job's row outcomes, each with its row index, status and error",
	properties: [
		jobIdProperty,
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: true,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 400 },
			default: 50,
			displayOptions: { show: { returnAll: [false] } },
			description: 'Max number of results to return',
		},
	],
	execute,
};
