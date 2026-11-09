import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { failureOf, zandoviError } from '../../transport/errors';
import type { ZandoviResponse } from '../../transport/request';
import { zandoviRequest } from '../../transport/request';
import { getJob, jobIdOf, jobIdProperty, jobPath } from './job';

const OPERATION = 'Batch Job → Get Result';

/**
 * A finished job's signed download link. The node never downloads the archive itself: an
 * archive of a large job could exceed n8n's memory, so the next node (HTTP Request with Response
 * Format File, which streams into n8n's binary storage) fetches, unzips or forwards it.
 */
async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const jobId = jobIdOf.call(this, itemIndex);

	let response: ZandoviResponse;
	try {
		response = await zandoviRequest.call(this, {
			method: 'GET',
			path: jobPath(jobId, '/result'),
			qs: { delivery: 'url' },
			resource: 'Batch job',
			operation: OPERATION,
		});
	} catch (caught) {
		// The request layer throws only zandoviError, so rebuilding it from its failure loses nothing.
		const failure = failureOf(caught as Error);
		if (failure.status === 409 && failure.code === 'BATCH_RESULT_NOT_READY') {
			// A job that ended FAILED or CANCELLED has no result either; say so rather than "not yet".
			const { status } = await getJob.call(this, jobId, OPERATION);
			failure.message =
				status === 'FAILED' || status === 'CANCELLED'
					? `Batch job ${jobId} ended ${status} and has no result`
					: `Batch job ${jobId} has not finished yet`;
		}
		throw zandoviError(this.getNode(), failure);
	}

	const link = response.body as IDataObject;
	return [{ json: { url: link.downloadUrl, expiresAt: link.expiresAt } }];
}

export const getResultOperation: ZandoviOperation = {
	value: 'getResult',
	name: 'Get Result',
	action: 'Get the result of a batch job',
	description:
		"Return a finished batch job's signed download link to the ZIP archive of its rendered images",
	properties: [jobIdProperty],
	execute,
};
