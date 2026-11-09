import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { failureOf } from '../transport/errors';
import { CANCELLED_MESSAGE, isCancelled } from '../transport/request';

/** One operation of a resource; each resource folder exports its operations through a ZandoviResource. */
export interface ZandoviOperation {
	/** The value of the Operation parameter. */
	value: string;
	name: string;
	action: string;
	/** One sentence an AI Agent can choose the operation by. */
	description: string;
	/** The operation's fields; the node shows them for this resource and operation only. */
	properties: INodeProperties[];
	/** Runs the operation for one input item and returns its output items. */
	execute(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]>;
}

/**
 * An operation that runs once for all input items rather than once per item (D-T2.c), such as
 * a batch submission; its output items are paired to every input item.
 */
export interface ZandoviWholeInputOperation extends Omit<ZandoviOperation, 'execute'> {
	executeAll(this: IExecuteFunctions): Promise<INodeExecutionData[]>;
}

export interface ZandoviResource {
	/** The value of the Resource parameter. */
	value: string;
	name: string;
	/** One sentence an AI Agent can choose the resource by. */
	description: string;
	operations: Array<ZandoviOperation | ZandoviWholeInputOperation>;
}

/** The Resource and Operation selectors plus every operation's fields, each shown only for its operation. */
export function buildProperties(resources: ZandoviResource[]): INodeProperties[] {
	const resourceOptions: INodePropertyOptions[] = resources.map((resource) => ({
		name: resource.name,
		value: resource.value,
		description: resource.description,
	}));
	const defaultResource = resources[0]?.value ?? '';
	return [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: resourceOptions,
			default: defaultResource,
			description: 'The kind of Zandovi object to work with',
		},
		...resources.flatMap((resource): INodeProperties[] => {
			const defaultOperation = resource.operations[0]?.value ?? '';
			return [
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: [resource.value] } },
					options: resource.operations.map((operation) => ({
						name: operation.name,
						value: operation.value,
						action: operation.action,
						description: operation.description,
					})),
					default: defaultOperation,
					description: `What to do with the ${resource.name}`,
				},
				...resource.operations.flatMap((operation) =>
					operation.properties.map((property) => ({
						...property,
						displayOptions: {
							...property.displayOptions,
							show: {
								...property.displayOptions?.show,
								resource: [resource.value],
								operation: [operation.value],
							},
						},
					})),
				),
			];
		}),
	];
}

/**
 * Runs the selected operation for each input item, one at a time and in order (AC2.12). With
 * Continue On Fail, a failing item becomes `{ error, status, code }` paired to its input and the
 * next item runs; otherwise the first failure throws with that item's index (AC2.10).
 */
export async function executeItems(
	this: IExecuteFunctions,
	resources: ZandoviResource[],
): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const wholeInput = wholeInputOperation.call(this, resources);
	if (wholeInput) return [await executeWholeInput.call(this, wholeInput)];
	const output: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		// A stopped execution starts no further item, Continue On Fail or not.
		if (isCancelled(this)) throw new NodeOperationError(this.getNode(), CANCELLED_MESSAGE);
		try {
			const resourceValue = this.getNodeParameter('resource', itemIndex) as string;
			const operationValue = this.getNodeParameter('operation', itemIndex) as string;
			const operation = resources
				.find((resource) => resource.value === resourceValue)
				?.operations.find(
					(candidate): candidate is ZandoviOperation =>
						candidate.value === operationValue && 'execute' in candidate,
				);
			if (!operation) {
				throw new NodeOperationError(
					this.getNode(),
					`The operation "${operationValue}" of resource "${resourceValue}" is not supported`,
					{ itemIndex },
				);
			}
			const results = await operation.execute.call(this, itemIndex);
			for (const result of results) output.push({ ...result, pairedItem: { item: itemIndex } });
		} catch (caught) {
			// The request layer and the operations throw NodeApiError or NodeOperationError.
			const error = caught as NodeOperationError;
			if (this.continueOnFail() && !isCancelled(this)) {
				const { message, status, code } = failureOf(error);
				output.push({ json: { error: message, status, code }, pairedItem: { item: itemIndex } });
				continue;
			}
			if (error.context) {
				error.context.itemIndex = itemIndex;
				throw error;
			}
			throw new NodeOperationError(this.getNode(), error, { itemIndex });
		}
	}
	return [output];
}

/** The selected operation when it runs once for all input items; undefined otherwise. */
function wholeInputOperation(
	this: IExecuteFunctions,
	resources: ZandoviResource[],
): ZandoviWholeInputOperation | undefined {
	if (this.getInputData().length === 0) return undefined;
	// Resource and Operation take no expressions, so item 0's values hold for every item.
	const resourceValue = this.getNodeParameter('resource', 0) as string;
	const operationValue = this.getNodeParameter('operation', 0) as string;
	const operation = resources
		.find((resource) => resource.value === resourceValue)
		?.operations.find((candidate) => candidate.value === operationValue);
	return operation && 'executeAll' in operation ? operation : undefined;
}

/**
 * Runs a whole-input operation once and pairs each output item to every input item. With
 * Continue On Fail, a failure becomes one `{ error, status, code }` item paired the same way.
 */
async function executeWholeInput(
	this: IExecuteFunctions,
	operation: ZandoviWholeInputOperation,
): Promise<INodeExecutionData[]> {
	const pairedItem = this.getInputData().map((_, item) => ({ item }));
	try {
		const results = await operation.executeAll.call(this);
		return results.map((result) => ({ ...result, pairedItem }));
	} catch (caught) {
		const error = caught as NodeOperationError;
		if (this.continueOnFail() && !isCancelled(this)) {
			const { message, status, code } = failureOf(error);
			return [{ json: { error: message, status, code }, pairedItem }];
		}
		if (error.context) throw error;
		throw new NodeOperationError(this.getNode(), error);
	}
}
