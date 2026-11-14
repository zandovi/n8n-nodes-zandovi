import type { ILoadOptionsFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import {
	getTemplateVariables,
	NO_VARIABLES_MESSAGE,
	parseVariablesJson,
	toVariables,
	VARIABLES_JSON_MESSAGE,
	variableFields,
	variablesInputProperty,
	variablesJsonProperty,
	variablesProperties,
	variablesProperty,
} from '../nodes/Zandovi/shared/variablesMapper';
import type { VariableInfo } from '../nodes/Zandovi/shared/variablesMapper';
import ticket from './fixtures/template-variables.json';
import coupon from './fixtures/template-detail.json';
import { createContext, problem } from './helpers/context';
import type { FakeReply } from './helpers/context';

const TEMPLATE_ID = '5b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const locator = (value: string) => ({ __rl: true, mode: 'id', value });

function loadOptions(replies: FakeReply[], templateId: unknown = locator(TEMPLATE_ID)) {
	const fake = createContext({ replies, parameters: { templateId } });
	return { ...fake, context: fake.context as unknown as ILoadOptionsFunctions };
}

describe('variableFields (AC3.4, AC3.5, D18, D21)', () => {
	const fields = variableFields(ticket.variables as VariableInfo[]);
	const field = (id: string) => fields.find((candidate) => candidate.id === id);

	it('gives one field per variable, in order, keyed by name and labelled by label or name, with the template default (D-T3.4)', () => {
		expect(fields.map((candidate) => [candidate.id, candidate.displayName])).toEqual([
			['attendee', 'Attendee (default: Ana Silva)'],
			['seats', 'Seats (default: 2)'],
			['tier', 'Tier (default: Standard)'],
			['event_date', 'Event Date'],
			['photo', 'Photo (default: zandovi://images/0e7c2a1b-3c4d-4e5f-8a9b…)'],
			['ticket_qr', 'ticket_qr (default: https://example.com/t/1)'],
			['ticket_barcode', 'Barcode'],
			['contact', 'Contact'],
		]);
	});

	it('keeps a long or multi-line default readable in the display name (D-T3.4)', () => {
		const [long, multiLine, empty, exact] = variableFields([
			{ name: 'message', label: 'Message', defaultValue: 'x'.repeat(41) },
			{ name: 'address', label: 'Address', defaultValue: 'Main Street 1\n  00-001 Warsaw' },
			{ name: 'note', label: 'Note', defaultValue: '' },
			{ name: 'code', label: 'Code', defaultValue: 'y'.repeat(40) },
		]);
		expect(long.displayName).toBe(`Message (default: ${'x'.repeat(40)}…)`);
		expect(multiLine.displayName).toBe('Address (default: Main Street 1 00-001 Warsaw)');
		expect(empty.displayName).toBe('Note');
		expect(exact.displayName).toBe(`Code (default: ${'y'.repeat(40)})`);
	});

	it('pre-fills nothing', () => {
		expect(field('attendee')).toMatchObject({ display: true, defaultMatch: false });
		for (const candidate of fields) expect(candidate).not.toHaveProperty('defaultValue');
	});

	// Found in a live n8n run: every starter variable is required and has a default, and n8n
	// refused to run with any field empty, although the API renders the default.
	it('requires a field only for a required variable without a default', () => {
		const [requiredWithDefault, requiredNoDefault, requiredEmptyDefault, optional] =
			variableFields([
				{ name: 'brand', required: true, defaultValue: 'NORTHWIND' },
				{ name: 'photo', type: 'image', required: true },
				{ name: 'code', required: true, defaultValue: '' },
				{ name: 'note', required: false },
			]);
		expect(requiredWithDefault.required).toBe(false);
		expect(requiredNoDefault.required).toBe(true);
		expect(requiredEmptyDefault.required).toBe(true);
		expect(optional.required).toBe(false);
	});

	it('maps number to a number field, validation.options to an options field, the rest to strings', () => {
		expect(field('seats')?.type).toBe('number');
		expect(field('tier')).toMatchObject({
			type: 'options',
			options: [
				{ name: 'Standard', value: 'Standard' },
				{ name: 'VIP', value: 'VIP' },
			],
		});
		for (const id of [
			'attendee',
			'event_date',
			'photo',
			'ticket_qr',
			'ticket_barcode',
			'contact',
		]) {
			expect(field(id)?.type, id).toBe('string');
		}
	});
});

describe('toVariables (AC3.6, AC3.7, D18)', () => {
	it('sends every value as a string: numbers in shortest decimal form, booleans as true/false', () => {
		expect(
			toVariables({
				attendee: 'Ana Silva',
				seats: 2,
				price: 19.9,
				ratio: 0.1 + 0.2,
				big: 1200,
				vip: true,
				printed: false,
			}),
		).toEqual({
			attendee: 'Ana Silva',
			seats: '2',
			price: '19.9',
			ratio: '0.30000000000000004',
			big: '1200',
			vip: 'true',
			printed: 'false',
		});
	});

	it('leaves out empty, null and undefined values so the template default renders', () => {
		expect(
			toVariables({ attendee: '', seats: null, tier: undefined as unknown as null, zero: 0 }),
		).toEqual({ zero: '0' });
		expect(toVariables(null)).toEqual({});
		expect(toVariables(undefined)).toEqual({});
	});

	it('sends a string as it is, including a number-like string a spreadsheet produced (E12)', () => {
		expect(toVariables({ seats: '1 200', note: ' ' })).toEqual({ seats: '1 200', note: ' ' });
	});

	it('keeps a mapped name the template no longer has (AC3.7)', () => {
		expect(toVariables({ removed_variable: 'still here' })).toEqual({
			removed_variable: 'still here',
		});
	});
});

describe('getTemplateVariables (AC3.4, AC3.7, E10)', () => {
	it('reads GET /templates/{id} and returns one field per variable', async () => {
		const { context, calls } = loadOptions([{ statusCode: 200, body: coupon }]);
		const result = await getTemplateVariables.call(context);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: 'GET',
			url: `https://app.zandovi.com/api/v1/templates/${TEMPLATE_ID}`,
		});
		expect(result.fields.map((field) => [field.id, field.displayName, field.required])).toEqual([
			['customer_name', 'Customer Name (default: John Doe)', false],
			['discount_code', 'Discount Code (default: SAVE20)', false],
		]);
	});

	it('reloads on every call, so Refresh picks up changed variables', async () => {
		const changed = { ...coupon, variables: [coupon.variables[0]] };
		const { context, calls } = loadOptions([
			{ statusCode: 200, body: coupon },
			{ statusCode: 200, body: changed },
		]);
		await getTemplateVariables.call(context);
		const result = await getTemplateVariables.call(context);
		expect(calls).toHaveLength(2);
		expect(result.fields.map((field) => field.id)).toEqual(['customer_name']);
	});

	it('says the template has no variables when it has none (E10)', async () => {
		const { context } = loadOptions([{ statusCode: 200, body: { ...coupon, variables: [] } }]);
		await expect(getTemplateVariables.call(context)).resolves.toEqual({
			fields: [],
			emptyFieldsNotice: NO_VARIABLES_MESSAGE,
		});
		expect(NO_VARIABLES_MESSAGE).toBe('This template has no variables');
		expect(variablesProperty.typeOptions?.resourceMapper?.noFieldsError).toBe(NO_VARIABLES_MESSAGE);
	});

	it('rejects a template ID that is not a UUID without calling the API', async () => {
		const { context, calls } = loadOptions([], locator('not-a-uuid'));
		await expect(getTemplateVariables.call(context)).rejects.toThrow('Enter a template ID (UUID)');
		expect(calls).toHaveLength(0);
	});

	it('reports a deleted template as not found (E11)', async () => {
		const { context } = loadOptions([
			{ statusCode: 404, body: problem(404, 'TEMPLATE_NOT_FOUND', 'Template not found') },
		]);
		await expect(getTemplateVariables.call(context)).rejects.toThrow(
			"Template not found, or not visible to this API key's account",
		);
	});
});

describe('variablesProperty (AC3.1, AC3.4)', () => {
	it('is a resource mapper that depends on the template', () => {
		expect(variablesProperty).toMatchObject({
			displayName: 'Variables',
			name: 'variables',
			type: 'resourceMapper',
			default: { mappingMode: 'defineBelow', value: null },
			typeOptions: {
				loadOptionsDependsOn: ['templateId.value'],
				resourceMapper: {
					resourceMapperMethod: 'getTemplateVariables',
					mode: 'add',
					supportAutoMap: false,
				},
			},
		});
	});
});

describe('parseVariablesJson (Variables Input: Using JSON)', () => {
	it('takes the object an expression resolved to, under the mapper rules', () => {
		expect(
			parseVariablesJson({
				customer_name: 'Ana',
				seats: 2,
				vip: true,
				note: '',
				gone: null,
				zero: 0,
			}),
		).toEqual({ variables: { customer_name: 'Ana', seats: '2', vip: 'true', zero: '0' } });
	});

	it('parses JSON text typed into the field', () => {
		expect(parseVariablesJson('{"customer_name": "Ana", "price": 19.9}')).toEqual({
			variables: { customer_name: 'Ana', price: '19.9' },
		});
	});

	it('treats empty text, null and undefined as no variables, so every default renders', () => {
		for (const empty of ['', '   ', '{}', null, undefined, {}]) {
			expect(parseVariablesJson(empty), String(empty)).toEqual({ variables: {} });
		}
	});

	it('refuses text that is not JSON, a list, or a scalar', () => {
		for (const bad of ['{customer_name: Ana}', '[1, 2]', '"Ana"', '42', ['Ana'], 'true', 7]) {
			expect(parseVariablesJson(bad), JSON.stringify(bad)).toEqual({
				error: VARIABLES_JSON_MESSAGE,
			});
		}
	});

	it('names a variable whose value is an object or a list', () => {
		expect(parseVariablesJson({ customer_name: 'Ana', address: { city: 'Warsaw' } })).toEqual({
			error:
				'Variable "address" in Variables (JSON) must be text, a number or true/false, not an object or a list',
		});
		expect(parseVariablesJson('{"tags": ["a", "b"]}')).toMatchObject({
			error: expect.stringContaining('Variable "tags"'),
		});
	});
});

describe('Variables Input fields', () => {
	it('defaults to the mapper, so workflows saved before the switch keep working', () => {
		expect(variablesInputProperty).toMatchObject({
			name: 'variablesInput',
			type: 'options',
			default: 'mapper',
			noDataExpression: true,
		});
		expect(
			(variablesInputProperty.options as Array<{ value: string }>).map((option) => option.value),
		).toEqual(['mapper', 'json']);
	});

	it('shows the mapper for Map Each Variable and the JSON field for Using JSON', () => {
		expect(variablesProperty.displayOptions?.show?.variablesInput).toEqual(['mapper']);
		expect(variablesJsonProperty).toMatchObject({
			name: 'variablesJson',
			type: 'json',
			default: '{}',
			displayOptions: { show: { variablesInput: ['json'] } },
		});
		expect(variablesJsonProperty).not.toHaveProperty('noDataExpression');
		expect(variablesProperties.map((property) => property.name)).toEqual([
			'variablesInput',
			'variables',
			'variablesJson',
		]);
	});
});
