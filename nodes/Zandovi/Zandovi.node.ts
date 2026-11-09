import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { getLibraryProjects, getLibraryTemplates } from './resources/template/createFromLibrary';
import { templateResource } from './resources/template';
import type { ZandoviResource } from './shared/operations';
import { imageResource } from './resources/image';
import { batchJobResource } from './resources/batchJob';
import { buildProperties, executeItems } from './shared/operations';
import { getProjects, searchTemplates } from './shared/templateLocator';
import { getTemplateVariables } from './shared/variablesMapper';

// Each resource lives in its own folder under resources/ and is listed here.
const resources: ZandoviResource[] = [templateResource, imageResource, batchJobResource];

export class Zandovi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zandovi',
		name: 'zandovi',
		icon: { light: 'file:zandovi.svg', dark: 'file:zandovi.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Render Zandovi image templates with variable values, upload images and run batch jobs',
		defaults: {
			name: 'Zandovi',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'zandoviApi',
				required: true,
			},
		],
		properties: buildProperties(resources),
	};

	// The Template locator and Variables mapper (shared/), used by every resource that picks a template.
	methods = {
		loadOptions: { getProjects, getLibraryProjects, getLibraryTemplates },
		listSearch: { searchTemplates },
		resourceMapping: { getTemplateVariables },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return executeItems.call(this, resources);
	}
}
