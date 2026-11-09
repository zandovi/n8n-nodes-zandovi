import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeProperties,
	ResourceMapperField,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { zandoviRequest } from '../transport/request';
import { isUuid, TEMPLATE_ID_MESSAGE } from './templateLocator';

export const NO_VARIABLES_MESSAGE = 'This template has no variables';

/** A template variable as `GET /templates/{id}` describes it (VariableInfo). */
export interface VariableInfo {
	name: string;
	type?: string;
	label?: string;
	required?: boolean;
	defaultValue?: string;
	validation?: { options?: string[] };
}

/** How much of a template default the field name shows before an ellipsis (D-T3.4). */
const DEFAULT_PREVIEW_LENGTH = 40;

/**
 * The field name: the label (or name), followed by the template default when there is one, as
 * in `Recipient Name (default: Ana Silva)` (D-T3.4). n8n's editor shows a mapper field's
 * displayName but no description of it, so the default goes in the name.
 */
function fieldDisplayName(variable: VariableInfo): string {
	const label = variable.label || variable.name;
	const preview = Array.from((variable.defaultValue ?? '').replace(/\s+/g, ' ').trim());
	if (preview.length === 0) return label;
	const shown =
		preview.length > DEFAULT_PREVIEW_LENGTH
			? `${preview.slice(0, DEFAULT_PREVIEW_LENGTH).join('')}…`
			: preview.join('');
	return `${label} (default: ${shown})`;
}

/**
 * One mapper field per variable (AC3.4, AC3.5): `number` gets a number field, a variable with
 * `validation.options` an options field, every other type a string field. Nothing is
 * pre-filled (D21); the template default is shown in the field name (D-T3.4). A field is
 * required only for a required variable without a default.
 */
export function variableFields(variables: VariableInfo[]): ResourceMapperField[] {
	return variables.map((variable) => {
		const choices = variable.validation?.options ?? [];
		const field: ResourceMapperField = {
			id: variable.name,
			displayName: fieldDisplayName(variable),
			// The API accepts a required variable left out when it has a default, which then
			// renders; marking such a field required would make n8n refuse to run with it empty.
			required: variable.required === true && (variable.defaultValue ?? '') === '',
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type: choices.length > 0 ? 'options' : variable.type === 'number' ? 'number' : 'string',
		};
		if (choices.length > 0)
			field.options = choices.map((choice) => ({ name: choice, value: choice }));
		return field;
	});
}

/** The Variables mapper's fields for the chosen template, read fresh on every call (Refresh). */
export async function getTemplateVariables(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const templateId = String(this.getNodeParameter('templateId', '', { extractValue: true }));
	if (!isUuid(templateId)) throw new NodeOperationError(this.getNode(), TEMPLATE_ID_MESSAGE);
	const response = await zandoviRequest.call(this, {
		method: 'GET',
		path: `/templates/${templateId}`,
		resource: 'Template',
		operation: 'loading template variables',
	});
	const { variables } = response.body as { variables?: VariableInfo[] };
	const fields = variableFields(variables ?? []);
	return fields.length > 0 ? { fields } : { fields, emptyFieldsNotice: NO_VARIABLES_MESSAGE };
}

/**
 * The mapped values as the API's `variables` map (AC3.6, D18): every value a string (numbers in
 * their shortest decimal form, booleans as true/false), and empty, null or undefined values
 * left out so the template default renders. Names the template no longer has are kept.
 */
export function toVariables(
	value: ResourceMapperValue['value'] | undefined,
): Record<string, string> {
	const variables: Record<string, string> = {};
	for (const [name, mapped] of Object.entries(value ?? {})) {
		if (mapped === undefined || mapped === null || mapped === '') continue;
		variables[name] = String(mapped);
	}
	return variables;
}

/** The Variables mapper's values for an item, as the API's `variables` map. */
export function mappedVariables(
	this: IExecuteFunctions,
	itemIndex: number,
): Record<string, string> {
	const mapper = this.getNodeParameter('variables', itemIndex, null) as ResourceMapperValue | null;
	return toVariables(mapper?.value);
}

/** The Variables mapper: one field per variable of the template the locator points at. */
export const variablesProperty: INodeProperties = {
	displayName: 'Variables',
	name: 'variables',
	type: 'resourceMapper',
	noDataExpression: true,
	default: { mappingMode: 'defineBelow', value: null },
	required: true,
	description:
		"The value for each of the template's variables; empty optional fields use the template default",
	typeOptions: {
		loadOptionsDependsOn: ['templateId.value'],
		resourceMapper: {
			resourceMapperMethod: 'getTemplateVariables',
			mode: 'add',
			fieldWords: { singular: 'variable', plural: 'variables' },
			addAllFields: true,
			multiKeyMatch: false,
			supportAutoMap: false,
			noFieldsError: NO_VARIABLES_MESSAGE,
		},
	},
};
