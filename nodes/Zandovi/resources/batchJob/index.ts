import type { ZandoviResource } from '../../shared/operations';
import { cancelOperation } from './cancel';
import { getOperation } from './get';
import { getItemsOperation } from './getItems';
import { getResultOperation } from './getResult';
import { submitOperation } from './submit';

export const batchJobResource: ZandoviResource = {
	value: 'batchJob',
	name: 'Batch Job',
	description: 'Render a template once per input item in one batch job, and read or cancel its jobs',
	operations: [submitOperation, getOperation, getItemsOperation, getResultOperation, cancelOperation],
};
