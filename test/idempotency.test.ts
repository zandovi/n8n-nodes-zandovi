import { createHash } from 'crypto';
import type { IExecuteFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { idempotencyKey } from '../nodes/Zandovi/shared/idempotency';
import { createContext } from './helpers/context';

function contextWith(
	workflowId: string,
	executionId: string | undefined,
	nodeName = 'Zandovi',
	runIndex = 0,
) {
	const { context } = createContext({ replies: [], workflowId, executionId, runIndex });
	const node = context.getNode();
	return { ...context, getNode: () => ({ ...node, name: nodeName }) } as IExecuteFunctions;
}

describe('idempotencyKey (AC3.11, AC6.3, D14, D-T12.1, D-T12.2)', () => {
	it('is n8n- plus the sha256 hex of "<workflowId>:<executionId>:<node name>:<runIndex>:<itemIndex>"', () => {
		expect(idempotencyKey.call(contextWith('wf-1', 'exec-42'), 0)).toBe(
			'n8n-f537f7fca803e68e9263eec13f4a1a517acbc0e453304a7b6b44ec835ad1c7cb',
		);
	});

	it('takes a suffix other than the item index, for the batch key', () => {
		expect(idempotencyKey.call(contextWith('wf-1', 'exec-42'), 'batch')).toBe(
			'n8n-3b1631d37c9c6aca4180c0eb8dbed3f0efbfc6f04599d6a8275b44f715734693',
		);
	});

	it('reads the workflow id and execution id from the execute-functions interface (A8)', () => {
		const context = contextWith('wf-1', 'exec-42');
		const key = idempotencyKey.call(context, 0);
		expect(idempotencyKey.call(contextWith('wf-1', 'exec-43'), 0)).not.toBe(key);
		// E15: the same node name in another workflow never collides.
		expect(idempotencyKey.call(contextWith('wf-2', 'exec-42'), 0)).not.toBe(key);
		expect(idempotencyKey.call(contextWith('wf-1', 'exec-42', 'Zandovi1'), 0)).not.toBe(key);
		expect(idempotencyKey.call(contextWith('wf-1', 'exec-42'), 1)).not.toBe(key);
	});

	it('differs between runs of the node in one execution (Loop Over Items, agent tool calls)', () => {
		const run0 = contextWith('wf-1', 'exec-42', 'Zandovi', 0);
		const run1 = contextWith('wf-1', 'exec-42', 'Zandovi', 1);
		expect(idempotencyKey.call(run1, 0)).toBe(
			`n8n-${sha256('wf-1:exec-42:Zandovi:1:0')}`,
		);
		expect(idempotencyKey.call(run1, 0)).not.toBe(idempotencyKey.call(run0, 0));
		expect(idempotencyKey.call(run1, 'batch')).not.toBe(idempotencyKey.call(run0, 'batch'));
		// A retry stays inside one run (A5), so it derives the same key.
		expect(idempotencyKey.call(run1, 0)).toBe(idempotencyKey.call(run1, 0));
	});

	it('uses run index 0 when the run index is not available', () => {
		const context = contextWith('wf-1', 'exec-42');
		const withoutRunIndex = { ...context, getWorkflowDataProxy: () => ({}) } as IExecuteFunctions;
		expect(idempotencyKey.call(withoutRunIndex, 0)).toBe(idempotencyKey.call(context, 0));
	});

	it('is a stable 68-character visible-ASCII key whatever the node name', () => {
		const context = contextWith('wf-1', 'exec-42', 'Render ✨ coupon: "summer"');
		const key = idempotencyKey.call(context, 0);
		expect(key).toMatch(/^n8n-[0-9a-f]{64}$/);
		expect(idempotencyKey.call(context, 0)).toBe(key);
	});

	it('is undefined when the execution id is not available', () => {
		expect(idempotencyKey.call(contextWith('wf-1', undefined), 0)).toBeUndefined();
		expect(idempotencyKey.call(contextWith('wf-1', ''), 0)).toBeUndefined();
		expect(idempotencyKey.call(contextWith('wf-1', undefined, 'Zandovi', 3), 'batch')).toBeUndefined();
	});
});

function sha256(source: string): string {
	return createHash('sha256').update(source).digest('hex');
}
