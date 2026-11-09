import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { zandoviRequest } from '../../transport/request';
import { getJob, jobIdOf, jobIdProperty, jobPath } from './job';

const OPERATION = 'Batch Job → Cancel';

/**
 * Cancels the job, then reads it back: the API answers the cancel with 204 and no body, so the
 * output is the job as it stands, plus `refundedRows`, the rows a cancelled job did not render
 * and that were refunded (`totalItems − completedItems`, the API's own refund rule; 0 when the
 * job had already finished and the cancel did nothing).
 */
async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const jobId = jobIdOf.call(this, itemIndex);
	await zandoviRequest.call(this, {
		method: 'POST',
		path: jobPath(jobId, '/cancel'),
		resource: 'Batch job',
		operation: OPERATION,
	});
	const job = await getJob.call(this, jobId, OPERATION);
	const refundedRows =
		job.status === 'CANCELLED'
			? Math.max(0, Number(job.totalItems ?? 0) - Number(job.completedItems ?? 0))
			: 0;
	return [{ json: { ...job, refundedRows } }];
}

export const cancelOperation: ZandoviOperation = {
	value: 'cancel',
	name: 'Cancel',
	action: 'Cancel a batch job',
	description: 'Stop a running batch job and refund the rows it has not rendered yet',
	properties: [jobIdProperty],
	execute,
};
