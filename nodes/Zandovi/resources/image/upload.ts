import type { IBinaryData, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { zandoviRequest } from '../../transport/request';
import { buildMultipart } from './multipart';
import { withReference } from './reference';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TYPE_BY_EXTENSION: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
};

/**
 * The binary's own type, else the one its file extension implies (E23, D-T11.3). A missing,
 * empty or generic `application/octet-stream` type counts as no type.
 */
function typeOf(binary: IBinaryData): string {
	const declared = binary.mimeType?.split(';')[0].trim().toLowerCase() ?? '';
	if (declared && declared !== 'application/octet-stream') return declared;
	const extension = (binary.fileExtension ?? binary.fileName?.split('.').pop() ?? '')
		.replace(/^\./, '')
		.toLowerCase();
	return TYPE_BY_EXTENSION[extension] ?? (declared || 'unknown');
}

/**
 * The binary's size in bytes as known before reading it: n8n's `bytes`, the stored file's metadata
 * (filesystem and S3 modes), or the length the inline base64 data decodes to; undefined when none
 * of these is available.
 */
async function knownSize(
	this: IExecuteFunctions,
	binary: IBinaryData,
): Promise<number | undefined> {
	if (typeof binary.bytes === 'number') return binary.bytes;
	if (binary.id) {
		try {
			return (await this.helpers.getBinaryMetadata(binary.id)).fileSize;
		} catch {
			return undefined;
		}
	}
	if (typeof binary.data === 'string' && binary.data.length > 0) {
		const padding = binary.data.endsWith('==') ? 2 : binary.data.endsWith('=') ? 1 : 0;
		return Math.floor((binary.data.length * 3) / 4) - padding;
	}
	return undefined;
}

function tooLarge(this: IExecuteFunctions, bytes: number, itemIndex: number): NodeOperationError {
	const megabytes = (bytes / (1024 * 1024)).toFixed(1);
	return new NodeOperationError(this.getNode(), `Image is ${megabytes} MB; the limit is 5 MB`, {
		itemIndex,
	});
}

export const uploadOperation: ZandoviOperation = {
	value: 'upload',
	name: 'Upload',
	action: 'Upload an image',
	description:
		'Upload an image from a binary field or a URL and return its zandovi://images reference for an image variable',
	properties: [
		{
			displayName: 'Source',
			name: 'source',
			type: 'options',
			options: [
				{
					name: 'Binary File',
					value: 'binary',
					description: 'Read the image from a binary field of the input item',
				},
				{ name: 'URL', value: 'url', description: 'Let Zandovi download the image from a URL' },
			],
			default: 'binary',
			description: 'Where the image comes from',
		},
		{
			displayName: 'Input Binary Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			displayOptions: { show: { source: ['binary'] } },
			description: 'The name of the binary field of the input item that holds the image',
		},
		{
			displayName: 'Image URL',
			name: 'url',
			type: 'string',
			default: '',
			displayOptions: { show: { source: ['url'] } },
			description: 'A public URL Zandovi downloads the image from',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			description: 'Optional settings for the uploaded image',
			options: [
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					default: '',
					description: 'The name to store the image under',
				},
				{
					displayName: 'Visibility',
					name: 'visibility',
					type: 'options',
					options: [
						{ name: 'Private', value: 'PRIVATE', description: 'Only you can use the image' },
						{
							name: 'Shared',
							value: 'SHARED',
							description: 'Other members of your organisation can use the image',
						},
					],
					default: 'PRIVATE',
					description: 'Whether other members of your organisation can use the image',
				},
			],
		},
	],
	async execute(this: IExecuteFunctions, itemIndex: number) {
		const source = this.getNodeParameter('source', itemIndex, 'binary') as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
		const labels = { resource: 'Image', operation: 'Image → Upload' };
		const fields: IDataObject = {};
		if (options.name) fields.name = options.name;
		if (options.visibility) fields.visibility = options.visibility;

		if (source === 'url') {
			const url = this.getNodeParameter('url', itemIndex) as string;
			const response = await zandoviRequest.call(this, {
				method: 'POST',
				path: '/images',
				body: { url, ...fields },
				...labels,
			});
			return [{ json: withReference(response.body as IDataObject) }];
		}

		const field = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
		const binary = this.getInputData()[itemIndex]?.binary?.[field];
		if (!binary) {
			throw new NodeOperationError(
				this.getNode(),
				`Input item ${itemIndex} has no binary field '${field}'`,
				{ itemIndex },
			);
		}
		const mimeType = typeOf(binary);
		if (!ALLOWED_TYPES.includes(mimeType)) {
			throw new NodeOperationError(
				this.getNode(),
				`Unsupported image type ${mimeType}; use JPEG, PNG, GIF or WebP`,
				{ itemIndex },
			);
		}
		// Refuse an oversized file before loading it into memory, then check the bytes read.
		const declared = await knownSize.call(this, binary);
		if (declared !== undefined && declared > MAX_IMAGE_BYTES)
			throw tooLarge.call(this, declared, itemIndex);
		// Read through the helper, never from disk, so filesystem and S3 binary modes work (E22).
		const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, field);
		if (buffer.length > MAX_IMAGE_BYTES) throw tooLarge.call(this, buffer.length, itemIndex);
		const multipart = buildMultipart(
			{ field: 'file', fileName: binary.fileName ?? 'image', contentType: mimeType, data: buffer },
			Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])),
		);
		const response = await zandoviRequest.call(this, {
			method: 'POST',
			path: '/images',
			body: multipart.body,
			headers: { 'Content-Type': multipart.contentType },
			...labels,
		});
		return [{ json: withReference(response.body as IDataObject) }];
	},
};
