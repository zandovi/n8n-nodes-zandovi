import type { ZandoviResource } from '../../shared/operations';
import { getManyOperation } from './getMany';
import { uploadOperation } from './upload';

export const imageResource: ZandoviResource = {
	value: 'image',
	name: 'Image',
	description: 'Upload images for templates to use, and list the images of your organisation',
	operations: [uploadOperation, getManyOperation],
};
