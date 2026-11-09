import type { ZandoviResource } from '../../shared/operations';
import { createFromLibraryOperation } from './createFromLibrary';
import { generateOperation } from './generate';
import { getOperation } from './get';
import { getManyOperation } from './getMany';

export const templateResource: ZandoviResource = {
	value: 'template',
	name: 'Template',
	description: 'Render Zandovi templates with variable values and read their details',
	operations: [generateOperation, getOperation, getManyOperation, createFromLibraryOperation],
};
