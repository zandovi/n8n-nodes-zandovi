import type { NodeOperationError } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import { LEAK_SENTINEL, createContext, probeResource, problem } from './helpers/context';
import type { FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const items = [{ json: { row: 0 } }, { json: { row: 1 } }, { json: { row: 2 } }];
const probeParameters = (name: string, itemIndex: number) =>
	({ resource: 'probe', operation: 'get', probeId: `p${itemIndex}` })[name];

const found = (id: string): FakeReply => ({ statusCode: 200, body: { id } });
const revoked: FakeReply = {
	statusCode: 401,
	body: problem(401, 'UNAUTHORIZED', 'API key revoked'),
};

function run(replies: FakeReply[], continueOnFail = false) {
	const fake = createContext({ replies, items, parameters: probeParameters, continueOnFail });
	return { ...fake, result: executeItems.call(fake.context, [probeResource]) };
}

beforeEach(() => {
	vi.mocked(sleep).mockClear();
});

describe('executeItems', () => {
	it('runs the selected operation once per item, in order, pairing each output to its input', async () => {
		const { result, calls } = run([found('p0'), found('p1'), found('p2')]);
		await expect(result).resolves.toEqual([
			[
				{ json: { id: 'p0' }, pairedItem: { item: 0 } },
				{ json: { id: 'p1' }, pairedItem: { item: 1 } },
				{ json: { id: 'p2' }, pairedItem: { item: 2 } },
			],
		]);
		expect(calls.map((call) => call.url)).toEqual([
			'https://app.zandovi.com/api/v1/probes/p0',
			'https://app.zandovi.com/api/v1/probes/p1',
			'https://app.zandovi.com/api/v1/probes/p2',
		]);
	});

	it('starts request N+1 only after request N has finished, retries included (AC2.12)', async () => {
		const rateLimited: FakeReply = {
			statusCode: 429,
			headers: { 'retry-after': '1' },
			body: problem(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.'),
		};
		const { result, events } = run([found('p0'), rateLimited, found('p1'), found('p2')]);
		await result;
		expect(events).toEqual([
			'start 1',
			'end 1',
			'start 2',
			'end 2',
			'start 3',
			'end 3',
			'start 4',
			'end 4',
		]);
		expect(vi.mocked(sleep).mock.calls).toEqual([[1000, undefined]]);
	});

	it('with Continue On Fail, turns a failing item into { error, status, code } and goes on (AC2.10, E8)', async () => {
		const { result, calls } = run([found('p0'), revoked, revoked], true);
		const [output] = await result;
		expect(output).toEqual([
			{ json: { id: 'p0' }, pairedItem: { item: 0 } },
			{
				json: {
					error: 'Invalid or revoked API key. Create one under Settings → API Keys.',
					status: 401,
					code: 'UNAUTHORIZED',
				},
				pairedItem: { item: 1 },
			},
			{
				json: {
					error: 'Invalid or revoked API key. Create one under Settings → API Keys.',
					status: 401,
					code: 'UNAUTHORIZED',
				},
				pairedItem: { item: 2 },
			},
		]);
		expect(calls).toHaveLength(3);
		expect(JSON.stringify(output)).not.toContain(LEAK_SENTINEL);
	});

	it('with Continue On Fail, reports a timeout with a null status', async () => {
		const timeout = Object.assign(new Error('timeout of 120000ms exceeded'), {
			code: 'ECONNABORTED',
		});
		const { result } = run([{ throws: timeout }, found('p1'), found('p2')], true);
		const [output] = await result;
		expect(output[0]).toEqual({
			json: { error: 'Zandovi did not respond within 120 s', status: null, code: 'TIMEOUT' },
			pairedItem: { item: 0 },
		});
		expect(output).toHaveLength(3);
	});

	it('without Continue On Fail, throws the first failure with its item index and stops (AC2.10)', async () => {
		const { result, calls } = run([
			found('p0'),
			{ statusCode: 404, body: problem(404, 'NOT_FOUND', 'gone') },
			found('p2'),
		]);
		const error = (await result.catch((caught: unknown) => caught)) as NodeOperationError;
		expect(error.message).toBe("Template not found, or not visible to this API key's account");
		expect(error.context.itemIndex).toBe(1);
		expect(calls).toHaveLength(2);
	});

	it('rejects an unknown operation with the item index', async () => {
		const fake = createContext({
			replies: [],
			items: [{ json: {} }],
			parameters: { resource: 'probe', operation: 'explode' },
		});
		const error = (await executeItems
			.call(fake.context, [probeResource])
			.catch((caught: unknown) => caught)) as NodeOperationError;
		expect(error.message).toBe('The operation "explode" of resource "probe" is not supported');
		expect(error.context.itemIndex).toBe(0);
	});
});
