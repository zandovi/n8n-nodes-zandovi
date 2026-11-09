import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	INodeExecutionData,
} from 'n8n-workflow';
import { vi } from 'vitest';
import type { ZandoviResource } from '../../nodes/Zandovi/shared/operations';
import { zandoviRequest } from '../../nodes/Zandovi/transport/request';

/** The API key the fake credential holds; no output or error may contain it. */
export const LEAK_SENTINEL = 'kpn_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

export const NODE: INode = {
	id: 'node-1',
	name: 'Zandovi',
	type: '@zandovi/n8n-nodes-zandovi.zandovi',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** What the stubbed HTTP helper answers one call with: a response, or an error it throws. */
export type FakeReply =
	| { statusCode: number; headers?: IDataObject; body?: unknown }
	| { throws: Error };

export interface FakeContextOptions {
	replies: FakeReply[];
	items?: INodeExecutionData[];
	parameters?: IDataObject | ((name: string, itemIndex: number) => unknown);
	continueOnFail?: boolean;
	/** The credential's Base URL; `null` leaves it unset, so the default applies. */
	baseUrl?: string | null;
	/** What `getWorkflow().id` and `getExecutionId()` return. */
	workflowId?: string;
	executionId?: string;
	/** What the workflow data proxy's `$runIndex` holds; 0 by default. */
	runIndex?: number;
}

/**
 * A minimal IExecuteFunctions. Its httpRequestWithAuthentication behaves like n8n's: it adds the
 * credential's X-Api-Key header, and the full response it returns carries the request config
 * (as an axios response does), so a request layer that copied the raw response into an error
 * would leak the key.
 */
export function createContext(options: FakeContextOptions) {
	const replies = [...options.replies];
	const calls: IHttpRequestOptions[] = [];
	const events: string[] = [];

	const send = async (requestOptions: IHttpRequestOptions, authenticated: boolean) => {
		// A multipart body (FormData) cannot be structured-cloned; keep it by reference.
		let snapshot: IHttpRequestOptions;
		try {
			snapshot = structuredClone(requestOptions);
		} catch {
			snapshot = { ...requestOptions };
		}
		const call = calls.push(snapshot);
		events.push(`start ${call}`);
		// Yield, as a real request would, so overlapping requests would interleave their events.
		for (let tick = 0; tick < 5; tick++) await Promise.resolve();
		events.push(`end ${call}`);
		const reply = replies.shift();
		if (!reply) throw new Error(`No reply stubbed for request ${call}`);
		if ('throws' in reply) throw reply.throws;
		const headers: IDataObject = { ...requestOptions.headers };
		if (authenticated) headers['X-Api-Key'] = LEAK_SENTINEL;
		return { headers: {}, body: '', ...reply, config: { headers } };
	};

	const httpRequestWithAuthentication = vi.fn(async function (
		credentialType: string,
		requestOptions: IHttpRequestOptions,
	) {
		if (credentialType !== 'zandoviApi') throw new Error(`Unexpected credential ${credentialType}`);
		return await send(requestOptions, true);
	});
	/** n8n's unauthenticated helper: same reply queue and call log, no API key. */
	const httpRequest = vi.fn(async (requestOptions: IHttpRequestOptions) =>
		send(requestOptions, false),
	);

	const parameter = (name: string, itemIndex: number): unknown => {
		const { parameters } = options;
		if (typeof parameters === 'function') return parameters(name, itemIndex);
		return parameters?.[name];
	};

	// Execute functions call getNodeParameter(name, itemIndex, fallback, options); load-options
	// functions call getNodeParameter(name, fallback, options). Both honour extractValue.
	const getNodeParameter = (name: string, ...rest: unknown[]) => {
		const executing = typeof rest[0] === 'number';
		const [fallback, getOptions] = (executing ? rest.slice(1) : rest) as [
			unknown,
			{ extractValue?: boolean } | undefined,
		];
		let value = parameter(name, executing ? (rest[0] as number) : 0);
		if (getOptions?.extractValue && value !== null && typeof value === 'object' && '__rl' in value)
			value = (value as { value: unknown }).value;
		return value === undefined ? fallback : value;
	};

	const prepareBinaryData = vi.fn(async (data: Buffer, fileName?: string, mimeType?: string) => ({
		data: data.toString('base64'),
		fileName,
		mimeType,
		fileSize: `${data.length} B`,
	}));

	const context = {
		getInputData: () => options.items ?? [{ json: {} }],
		getNodeParameter,
		continueOnFail: () => options.continueOnFail ?? false,
		getNode: () => NODE,
		getWorkflow: () => ({ id: options.workflowId ?? 'wf-1', active: false }),
		getExecutionId: () => options.executionId,
		getWorkflowDataProxy: () => ({ $runIndex: options.runIndex ?? 0 }),
		getCredentials: async () => ({
			apiKey: LEAK_SENTINEL,
			baseUrl:
				options.baseUrl === null ? undefined : (options.baseUrl ?? 'https://app.zandovi.com'),
		}),
		helpers: { httpRequestWithAuthentication, httpRequest, prepareBinaryData },
	} as unknown as IExecuteFunctions;

	return { context, calls, events, httpRequestWithAuthentication, httpRequest, prepareBinaryData };
}

/** A test-only resource whose one operation reads `/probes/{id}` through the request layer. */
export const probeResource: ZandoviResource = {
	value: 'probe',
	name: 'Probe',
	description: 'A test-only resource that reads one probe',
	operations: [
		{
			value: 'get',
			name: 'Get',
			action: 'Get a probe',
			description: 'Read one probe by its ID',
			properties: [
				{
					displayName: 'Probe ID',
					name: 'probeId',
					type: 'string',
					default: '',
					description: 'The ID of the probe to read',
				},
			],
			async execute(this: IExecuteFunctions, itemIndex: number) {
				const id = this.getNodeParameter('probeId', itemIndex) as string;
				const response = await zandoviRequest.call(this, {
					method: 'GET',
					path: `/probes/${id}`,
					resource: 'Template',
					operation: 'Probe → Get',
				});
				return [{ json: response.body as IDataObject }];
			},
		},
	],
};

export function problem(status: number, code: string, detail: string, extra: IDataObject = {}) {
	return {
		type: 'about:blank',
		title: 'Error',
		status,
		detail,
		code,
		requestId: 'req-123',
		timestamp: '2026-11-05T10:00:00Z',
		...extra,
	};
}
