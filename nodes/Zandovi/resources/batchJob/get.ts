import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { getJob, jobIdOf, jobIdProperty } from './job';

export const getOperation: ZandoviOperation = {
	value: 'get',
	name: 'Get',
	action: 'Get a batch job',
	description: "Read a batch job's status and row counts",
	properties: [jobIdProperty],
	async execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
		const job = await getJob.call(this, jobIdOf.call(this, itemIndex), 'Batch Job → Get');
		return [{ json: job }];
	},
};
