import type { IDataObject } from 'n8n-workflow';

/** The image with the `zandovi://images/<id>` reference an image variable accepts. */
export function withReference(image: IDataObject): IDataObject {
	return { ...image, reference: `zandovi://images/${String(image.id)}` };
}
