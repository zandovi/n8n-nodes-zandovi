import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { idempotencyKey } from '../../shared/idempotency';
import type { ZandoviOperation } from '../../shared/operations';
import { templateIdOf, templateLocatorProperties } from '../../shared/templateLocator';
import { mappedVariables, variablesProperty } from '../../shared/variablesMapper';
import { header } from '../../transport/errors';
import { zandoviRequest } from '../../transport/request';

export const DPI_AND_SCALE_MESSAGE = 'Use either Output DPI or Scale, not both';
export const SHARED_KEY_MESSAGE =
	'The Idempotency Key must differ between items that render different content; use an expression such as {{ $json.id }}';

interface GenerateOptions {
	fileName?: string;
	outputDpi?: number;
	scale?: number;
	quality?: number;
	backgroundColor?: string;
	expiresInDays?: number;
	idempotencyKey?: string;
}

/** The file name a Content-Disposition header gives: `filename*` decoded, else `filename`. */
export function contentDispositionFileName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
	if (extended) {
		try {
			return decodeURIComponent(extended[2].trim());
		} catch {
			// A malformed filename* falls back to filename.
		}
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
	return plain ? (plain[1] ?? plain[2]).trim() : undefined;
}

/** A percent-decoded header value; the raw value when it is not valid percent-encoding. */
function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** What the generate response headers report, shared by both deliveries (AC3.8, AC3.9). */
function responseFacts(headers: IDataObject) {
	const unknown = header(headers, 'x-unknown-variables');
	const quota = header(headers, 'x-quota-remaining')?.trim();
	const quotaRemaining = quota ? Number(quota) : Number.NaN;
	return {
		unknownVariables: unknown ? unknown.split(',').filter(Boolean).map(safeDecode) : [],
		idempotencyReplayed: header(headers, 'idempotency-replayed') === 'true',
		quotaRemaining: Number.isFinite(quotaRemaining) ? quotaRemaining : null,
	};
}

interface GenerateRequest {
	templateId: string;
	delivery: 'binary' | 'link';
	format: string;
	body: IDataObject;
	/** The custom Idempotency Key option, when set. */
	customKey?: string;
}

function buildRequest(this: IExecuteFunctions, itemIndex: number): GenerateRequest {
	const templateId = templateIdOf.call(this, itemIndex);
	const delivery = this.getNodeParameter('delivery', itemIndex) as 'binary' | 'link';
	const format = this.getNodeParameter('format', itemIndex) as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as GenerateOptions;

	if (options.outputDpi !== undefined && options.scale !== undefined) {
		throw new NodeOperationError(this.getNode(), DPI_AND_SCALE_MESSAGE, { itemIndex });
	}
	const renderOptions: IDataObject = {};
	if (options.outputDpi !== undefined) renderOptions.outputDpi = options.outputDpi;
	if (options.scale !== undefined) renderOptions.scale = options.scale;
	if (options.quality !== undefined && (format === 'jpeg' || format === 'webp'))
		renderOptions.quality = options.quality;
	if (options.backgroundColor) renderOptions.backgroundColor = options.backgroundColor;

	const body: IDataObject = { variables: mappedVariables.call(this, itemIndex), format };
	if (Object.keys(renderOptions).length > 0) body.options = renderOptions;
	if (options.fileName) body.filename = options.fileName;
	if (delivery === 'link') {
		body.delivery = 'link';
		if (options.expiresInDays !== undefined) body.expiresInDays = options.expiresInDays;
	}
	return { templateId, delivery, format, body, customKey: options.idempotencyKey || undefined };
}

/** Per execution context: the custom keys that more than one distinct request would send. */
const sharedKeysByContext = new WeakMap<object, Set<string>>();

/**
 * The custom Idempotency Keys that items rendering different content share. Computed once for
 * all input items, so a static key fails every affected item before its first render is charged,
 * rather than charging item 0 and failing item 1 with IDEMPOTENCY_KEY_REUSED.
 */
function sharedCustomKeys(this: IExecuteFunctions): Set<string> {
	const cached = sharedKeysByContext.get(this);
	if (cached) return cached;
	const requestByKey = new Map<string, string>();
	const shared = new Set<string>();
	const items = this.getInputData();
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		let request: GenerateRequest;
		try {
			request = buildRequest.call(this, itemIndex);
		} catch {
			continue; // The item reports its own error when it runs.
		}
		if (!request.customKey) continue;
		const fingerprint = JSON.stringify([request.templateId, request.body]);
		const seen = requestByKey.get(request.customKey);
		if (seen === undefined) requestByKey.set(request.customKey, fingerprint);
		else if (seen !== fingerprint) shared.add(request.customKey);
	}
	sharedKeysByContext.set(this, shared);
	return shared;
}

async function execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const { templateId, delivery, format, body, customKey } = buildRequest.call(this, itemIndex);
	if (customKey && sharedCustomKeys.call(this).has(customKey)) {
		throw new NodeOperationError(this.getNode(), SHARED_KEY_MESSAGE, { itemIndex });
	}
	const key = customKey || idempotencyKey.call(this, itemIndex);

	const response = await zandoviRequest.call(this, {
		method: 'POST',
		path: `/templates/${templateId}/generate`,
		body,
		headers: key ? { 'Idempotency-Key': key } : {},
		encoding: delivery === 'binary' ? 'arraybuffer' : undefined,
		resource: 'Template',
		operation: 'Template → Generate',
	});
	const facts = responseFacts(response.headers);

	if (delivery === 'link') {
		return [{ json: { ...(response.body as IDataObject), templateId, ...facts } }];
	}

	const bytes = Buffer.isBuffer(response.body)
		? response.body
		: Buffer.from(response.body as ArrayBuffer);
	const fileName = contentDispositionFileName(header(response.headers, 'content-disposition'));
	const mimeType = header(response.headers, 'content-type')?.split(';')[0].trim();
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
	const binary = await this.helpers.prepareBinaryData(bytes, fileName, mimeType);
	return [
		{
			json: { templateId, fileName, mimeType, fileSize: bytes.length, format, ...facts },
			binary: { [binaryPropertyName]: binary },
		},
	];
}

export const generateOperation: ZandoviOperation = {
	value: 'generate',
	name: 'Generate',
	action: 'Generate an image from a template',
	description: 'Render a Zandovi template with variable values and return the image file',
	properties: [
		...templateLocatorProperties,
		variablesProperty,
		{
			displayName: 'Delivery',
			name: 'delivery',
			type: 'options',
			options: [
				{
					name: 'Binary File',
					value: 'binary',
					description: 'Return the rendered file as binary data on the output item',
				},
				{
					name: 'Share Link',
					value: 'link',
					description: 'Publish the rendered file and return a public share link to it',
				},
			],
			default: 'binary',
			description: 'Whether to return the rendered file itself or a public link to it',
		},
		{
			displayName: 'Format',
			name: 'format',
			type: 'options',
			options: [
				{ name: 'PNG', value: 'png', description: 'A lossless PNG image' },
				{ name: 'JPEG', value: 'jpeg', description: 'A compressed JPEG image' },
				{ name: 'WebP', value: 'webp', description: 'A compressed WebP image' },
				{ name: 'PDF', value: 'pdf', description: 'A print-ready PDF document' },
			],
			default: 'png',
			description: 'The file format to render',
		},
		{
			displayName: 'Put Output File in Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			required: true,
			displayOptions: { show: { delivery: ['binary'] } },
			hint: 'The name of the output binary field to put the file in',
			description: 'The binary field of the output item that receives the rendered file',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			description: 'Optional settings for the render',
			options: [
				{
					displayName: 'Background Color',
					name: 'backgroundColor',
					type: 'color',
					default: '#ffffff',
					description: "A solid colour that replaces the design's background",
				},
				{
					displayName: 'File Name',
					name: 'fileName',
					type: 'string',
					default: '',
					description:
						"The rendered file's name; Zandovi adds the format's extension and uses the template name when empty",
				},
				{
					displayName: 'Idempotency Key',
					name: 'idempotencyKey',
					type: 'string',
					default: '',
					description:
						'A key that makes a repeated request return the first result without a new charge; with several items, use an expression that differs per item, such as one built from a field unique to the item; when empty, the node derives one from the execution and item',
				},
				{
					displayName: 'Link Expiry (Days)',
					name: 'expiresInDays',
					type: 'number',
					typeOptions: { minValue: 1, numberPrecision: 0 },
					default: 7,
					displayOptions: { show: { '/delivery': ['link'] } },
					description: "How many days the share link stays live, at most your plan's retention",
				},
				{
					displayName: 'Output DPI',
					name: 'outputDpi',
					type: 'options',
					options: [
						{ name: 'Screen (96)', value: 96, description: 'For on-screen use' },
						{ name: 'Draft (150)', value: 150, description: 'For low-cost print proofs' },
						{ name: 'Print (300)', value: 300, description: 'For production-quality print' },
					],
					default: 300,
					description: 'The print resolution to render at; use either this or Scale',
				},
				{
					displayName: 'Quality',
					name: 'quality',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 },
					default: 90,
					displayOptions: { show: { '/format': ['jpeg', 'webp'] } },
					description: 'The compression quality of a JPEG or WebP file, from 1 to 100',
				},
				{
					displayName: 'Scale',
					name: 'scale',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 4, numberPrecision: 0 },
					default: 2,
					description:
						'How many times the design size to render, from 1 to 4; use either this or Output DPI',
				},
			],
		},
	],
	execute,
};
