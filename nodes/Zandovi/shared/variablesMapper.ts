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
export const VARIABLES_JSON_MESSAGE =
	'Variables (JSON) must be a JSON object of variable names to values, such as {"customer_name": "Ana"}';

/** How the Variables Input field says the variables are given. */
export type VariablesInput = 'mapper' | 'json';

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

/**
 * A Variables (JSON) value as the API's `variables` map, under the same rules as the mapper: an
 * object of names to text, numbers or booleans, every value sent as a string, and empty, null
 * or undefined values left out so the template default renders. Accepts the object an
 * expression such as `{{ $json.variables }}` resolves to, or JSON text; an empty value is `{}`.
 * Returns an error message instead of throwing, so the caller can attach the item index.
 */
export function parseVariablesJson(
	raw: unknown,
): { variables: Record<string, string> } | { error: string } {
	let value = raw;
	if (typeof value === 'string') {
		if (value.trim() === '') return { variables: {} };
		try {
			value = JSON.parse(value);
		} catch {
			return { error: VARIABLES_JSON_MESSAGE };
		}
	}
	if (value === undefined || value === null) return { variables: {} };
	if (typeof value !== 'object' || Array.isArray(value)) return { error: VARIABLES_JSON_MESSAGE };
	const nested = Object.entries(value).find(
		([, entry]) => entry !== null && typeof entry === 'object',
	);
	if (nested) {
		return {
			error: `Variable "${nested[0]}" in Variables (JSON) must be text, a number or true/false, not an object or a list`,
		};
	}
	return { variables: toVariables(value as ResourceMapperValue['value']) };
}

/**
 * The item's variables as the API's `variables` map: from the Variables mapper, or from
 * Variables (JSON) when Variables Input is Using JSON. Workflows saved before Variables Input
 * existed have no value for it and keep using the mapper.
 */
export function mappedVariables(
	this: IExecuteFunctions,
	itemIndex: number,
): Record<string, string> {
	const input = this.getNodeParameter('variablesInput', itemIndex, 'mapper') as VariablesInput;
	if (input === 'json') {
		const parsed = parseVariablesJson(this.getNodeParameter('variablesJson', itemIndex, '{}'));
		if ('error' in parsed) {
			throw new NodeOperationError(this.getNode(), parsed.error, { itemIndex });
		}
		return parsed.variables;
	}
	const mapper = this.getNodeParameter('variables', itemIndex, null) as ResourceMapperValue | null;
	return toVariables(mapper?.value);
}

/** Whether the variables come from the mapper (one field per variable) or one JSON object. */
export const variablesInputProperty: INodeProperties = {
	displayName: 'Variables Input',
	name: 'variablesInput',
	type: 'options',
	noDataExpression: true,
	options: [
		{
			name: 'Map Each Variable',
			value: 'mapper',
			description: "Fill one field per variable of the chosen template",
		},
		{
			name: 'Using JSON',
			value: 'json',
			description:
				'Give all variables as one JSON object, for example from the input item, when the template changes per item',
		},
	],
	default: 'mapper',
	description: 'How to give the values of the template variables',
};

/** All variables as one JSON object, shown when Variables Input is Using JSON. */
export const variablesJsonProperty: INodeProperties = {
	displayName: 'Variables (JSON)',
	name: 'variablesJson',
	type: 'json',
	default: '{}',
	displayOptions: { show: { variablesInput: ['json'] } },
	hint: 'For example {{ $json.variables }}, or {"customer_name": "Ana", "discount_code": "SAVE20"}',
	description:
		'An object of variable names to values (text, numbers or true/false); a variable left out, empty or null uses the template default',
};

/** The Variables mapper: one field per variable of the template the locator points at. */
export const variablesProperty: INodeProperties = {
	displayName: 'Variables',
	name: 'variables',
	type: 'resourceMapper',
	noDataExpression: true,
	default: { mappingMode: 'defineBelow', value: null },
	required: true,
	displayOptions: { show: { variablesInput: ['mapper'] } },
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

/** The Variables fields every template-rendering operation shows, in order. */
export const variablesProperties: INodeProperties[] = [
	variablesInputProperty,
	variablesProperty,
	variablesJsonProperty,
];
