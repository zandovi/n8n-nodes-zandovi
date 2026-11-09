import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import type { ZandoviOperation } from '../../shared/operations';
import { zandoviRequest } from '../../transport/request';
import { withReference } from './reference';

/** The API clamps a page to 50 images. */
const PAGE_SIZE = 50;

export const getManyOperation: ZandoviOperation = {
	value: 'getMany',
	name: 'Get Many',
	action: 'Get many images',
	description: 'List the images of your organisation, optionally filtered by name',
	properties: [
		{
			displayName: 'Search',
			name: 'q',
			type: 'string',
			default: '',
			description: 'Only images whose name contains this text (case-insensitive)',
		},
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 500 },
			default: 50,
			displayOptions: { show: { returnAll: [false] } },
			description: 'Max number of results to return',
		},
	],
	async execute(this: IExecuteFunctions, itemIndex: number) {
		const q = this.getNodeParameter('q', itemIndex, '') as string;
		const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
		const limit = returnAll ? Infinity : (this.getNodeParameter('limit', itemIndex, 50) as number);
		const images: IDataObject[] = [];
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		while (images.length < limit) {
			const qs: IDataObject = { limit: Math.min(PAGE_SIZE, limit - images.length) };
			if (q) qs.q = q;
			if (cursor) qs.cursor = cursor;
			const response = await zandoviRequest.call(this, {
				method: 'GET',
				path: '/images',
				qs,
				resource: 'Image',
				operation: 'Image → Get Many',
			});
			const page = response.body as { items?: IDataObject[]; nextCursor?: string | null };
			const items = Array.isArray(page.items) ? page.items : [];
			images.push(...items);
			// A repeated cursor or an empty page that claims more would page forever.
			if (!page.nextCursor || items.length === 0 || seenCursors.has(page.nextCursor)) break;
			seenCursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		return images.slice(0, limit).map((image) => ({ json: withReference(image) }));
	},
};
