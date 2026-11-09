import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { zandoviRequest } from '../../transport/request';

/** The Job ID field of Get, Get Items, Get Result and Cancel. */
export const jobIdProperty: INodeProperties = {
	displayName: 'Job ID',
	name: 'jobId',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'e.g. 5b2c7e1a-8d3f-4c6b-9a1e-0f2d3c4b5a69',
	description: 'The ID of the batch job, as Batch Job → Submit returns it in jobId',
};

export function jobIdOf(this: IExecuteFunctions, itemIndex: number): string {
	return String(this.getNodeParameter('jobId', itemIndex)).trim();
}

export function jobPath(jobId: string, suffix = ''): string {
	return `/batch-jobs/${encodeURIComponent(jobId)}${suffix}`;
}

/** `GET /batch-jobs/{id}`: the job's status, counts and first errors. */
export async function getJob(
	this: IExecuteFunctions,
	jobId: string,
	operation: string,
): Promise<IDataObject> {
	const response = await zandoviRequest.call(this, {
		method: 'GET',
		path: jobPath(jobId),
		resource: 'Batch job',
		operation,
	});
	return response.body as IDataObject;
}
