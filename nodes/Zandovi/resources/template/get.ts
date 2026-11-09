import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { templateIdOf, templateLocatorProperties } from '../../shared/templateLocator';
import { zandoviRequest } from '../../transport/request';

async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const templateId = templateIdOf.call(this, itemIndex);
	const response = await zandoviRequest.call(this, {
		method: 'GET',
		path: `/templates/${templateId}`,
		resource: 'Template',
		operation: 'Template → Get',
	});
	return [{ json: response.body as IDataObject }];
}

export const getOperation: ZandoviOperation = {
	value: 'get',
	name: 'Get',
	action: 'Get a template',
	description: 'Read one Zandovi template, including its variables',
	properties: [...templateLocatorProperties],
	execute,
};
