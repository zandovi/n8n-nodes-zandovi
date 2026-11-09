import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { idempotencyKey } from '../../shared/idempotency';
import type { ZandoviWholeInputOperation } from '../../shared/operations';
import { templateIdOf, templateLocatorProperties } from '../../shared/templateLocator';
import { mappedVariables, variablesProperty } from '../../shared/variablesMapper';
import { zandoviError } from '../../transport/errors';
import { zandoviRequest } from '../../transport/request';
import { DPI_AND_SCALE_MESSAGE } from '../template/generate';
import { getJob } from './job';

export const POLL_INTERVAL_MS = 5_000;
export const TIMEOUT_RANGE_MESSAGE = 'Timeout (Minutes) must be a number from 1 to 60';
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];
const OPERATION = 'Batch Job → Submit';

interface SubmitOptions {
	filenamePattern?: string;
	outputDpi?: number;
	scale?: number;
	callbackUrl?: string;
	idempotencyKey?: string;
}

/** The plan's row cap from `GET /account`; null when the plan reports none. */
async function maxRowsPerJob(this: IExecuteFunctions): Promise<number | null> {
	const response = await zandoviRequest.call(this, {
		method: 'GET',
		path: '/account',
		resource: 'Account',
		operation: OPERATION,
	});
	const limit = (response.body as { limits?: { maxBatchRowsPerJob?: number | null } }).limits
		?.maxBatchRowsPerJob;
	return typeof limit === 'number' ? limit : null;
}

/** Why a FAILED job failed: its listed row errors, else its failed row count. */
function failureDetail(job: IDataObject): string {
	const errors = Array.isArray(job.errors) ? (job.errors as IDataObject[]) : [];
	if (errors.length > 0)
		return errors.map((entry) => `row ${String(entry.itemIndex)}: ${String(entry.error)}`).join('; ');
	return `${String(job.failedItems ?? 0)} of ${String(job.totalItems ?? 0)} rows failed`;
}

/**
 * Waits one poll interval through n8n's sleep, given the execution's cancel signal so a stopped
 * execution ends the wait (E30); the job itself keeps running.
 */
async function pause(this: IExecuteFunctions, jobId: string, ms: number): Promise<void> {
	// Optional call: n8n releases older than the cancel signal do not have it.
	const signal = this.getExecutionCancelSignal?.();
	await sleep(ms, signal).catch(() => undefined);
	if (signal?.aborted) {
		throw new NodeOperationError(
			this.getNode(),
			`The execution was cancelled; batch job ${jobId} keeps running`,
		);
	}
}

/**
 * Polls the job every 5 s until it is COMPLETED, FAILED or CANCELLED (AC6.5) and returns its
 * final body; a FAILED job raises (D23). When the timeout passes first, fails with the job id
 * and leaves the job running (AC6.6, D8).
 */
async function waitForJob(
	this: IExecuteFunctions,
	submitted: IDataObject,
	timeoutMinutes: number,
): Promise<IDataObject> {
	const jobId = String(submitted.jobId);
	const deadline = Date.now() + timeoutMinutes * 60_000;
	let job = submitted;
	for (;;) {
		// A replayed submission can already be finished; read its full body at once.
		if (!TERMINAL_STATUSES.includes(String(job.status))) {
			// The deadline is checked before each wait, and a wait never runs past it.
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new NodeOperationError(
					this.getNode(),
					`Batch job ${jobId} is still ${String(job.status)} after ${timeoutMinutes} min. It keeps running; check it later with Batch Job → Get, or use a Callback URL with a Wait node.`,
				);
			}
			await pause.call(this, jobId, Math.min(POLL_INTERVAL_MS, remaining));
		}
		job = await getJob.call(this, jobId, OPERATION);
		if (job.status === 'FAILED') {
			throw zandoviError(this.getNode(), {
				message: `Batch job ${jobId} failed: ${failureDetail(job)}`,
				status: null,
				code: 'BATCH_JOB_FAILED',
			});
		}
		if (TERMINAL_STATUSES.includes(String(job.status))) return job;
	}
}

/**
 * Turns all input items into the rows of one batch job (AC6.1, AC6.4): the template, format and
 * options come from the first item, the variables from each item. Checks the plan's row cap
 * first, so an oversized job is never submitted or charged (AC6.2, D11).
 */
async function executeAll(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const templateId = templateIdOf.call(this, 0);
	const format = this.getNodeParameter('format', 0) as string;
	const waitForCompletion = this.getNodeParameter('waitForCompletion', 0, true) as boolean;
	const options = this.getNodeParameter('options', 0, {}) as SubmitOptions;
	if (options.outputDpi !== undefined && options.scale !== undefined) {
		throw new NodeOperationError(this.getNode(), DPI_AND_SCALE_MESSAGE);
	}
	const timeoutMinutes = waitForCompletion
		? (this.getNodeParameter('timeoutMinutes', 0, 10) as number)
		: 0;
	// An expression can bypass the field's 1–60 bounds; refuse before anything is submitted.
	if (
		waitForCompletion &&
		!(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 60)
	) {
		throw new NodeOperationError(this.getNode(), TIMEOUT_RANGE_MESSAGE);
	}

	const cap = await maxRowsPerJob.call(this);
	if (cap !== null && items.length > cap) {
		throw new NodeOperationError(
			this.getNode(),
			`${items.length} items exceed your plan's limit of ${cap} rows per batch job. Put a Loop Over Items node with batch size ${cap} before this node.`,
		);
	}

	const template: IDataObject = { templateId, format };
	if (options.outputDpi !== undefined) template.options = { outputDpi: options.outputDpi };
	if (options.scale !== undefined) template.options = { scale: options.scale };
	if (options.filenamePattern) template.output = { filenamePattern: options.filenamePattern };
	const body: IDataObject = {
		template,
		rows: items.map((_, itemIndex) => mappedVariables.call(this, itemIndex)),
	};
	if (options.callbackUrl) body.callbackUrl = options.callbackUrl;
	const key = options.idempotencyKey || idempotencyKey.call(this, 'batch');

	const response = await zandoviRequest.call(this, {
		method: 'POST',
		path: '/batch-jobs',
		body,
		headers: key ? { 'Idempotency-Key': key } : {},
		resource: 'Batch job',
		operation: OPERATION,
	});
	const submitted = response.body as IDataObject;
	if (!waitForCompletion) return [{ json: submitted }];
	return [{ json: await waitForJob.call(this, submitted, timeoutMinutes) }];
}

export const submitOperation: ZandoviWholeInputOperation = {
	value: 'submit',
	name: 'Submit',
	action: 'Submit a batch job',
	description:
		'Render one template once per input item as a single batch job and return the job, by default once it has finished',
	properties: [
		...templateLocatorProperties,
		variablesProperty,
		{
			displayName: 'Format',
			name: 'format',
			type: 'options',
			options: [
				{ name: 'PNG', value: 'png', description: 'Lossless PNG images' },
				{ name: 'JPEG', value: 'jpeg', description: 'Compressed JPEG images' },
				{ name: 'WebP', value: 'webp', description: 'Compressed WebP images' },
				{ name: 'PDF', value: 'pdf', description: 'Print-ready PDF documents' },
			],
			default: 'png',
			description: 'The file format to render every row in',
		},
		{
			displayName: 'Wait for Completion',
			name: 'waitForCompletion',
			type: 'boolean',
			default: true,
			description:
				'Whether to wait until the job has finished and return its final state, or return the submitted job at once',
		},
		{
			displayName: 'Timeout (Minutes)',
			name: 'timeoutMinutes',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 60, numberPrecision: 0 },
			default: 10,
			displayOptions: { show: { waitForCompletion: [true] } },
			description:
				'How long to wait for the job before failing with its ID while it keeps running, from 1 to 60 minutes',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			description: 'Optional settings for the batch job',
			options: [
				{
					displayName: 'Callback URL',
					name: 'callbackUrl',
					type: 'string',
					default: '',
					placeholder: 'e.g. {{ $execution.resumeUrl }}',
					description:
						'A public https:// URL Zandovi POSTs to when the job finishes, such as the resume URL of a Wait node',
				},
				{
					displayName: 'File Name Pattern',
					name: 'filenamePattern',
					type: 'string',
					default: '',
					placeholder: 'e.g. {name}-{index}',
					description:
						'How to name the files in the result archive, using {variable}, {index}, {timestamp} and {random} placeholders, without an extension',
				},
				{
					displayName: 'Idempotency Key',
					name: 'idempotencyKey',
					type: 'string',
					default: '',
					description:
						'A key that makes a repeated submission return the first job without a new charge; when empty, the node derives one from the execution',
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
	executeAll,
};
