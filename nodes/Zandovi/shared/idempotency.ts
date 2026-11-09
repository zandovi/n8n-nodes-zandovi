import { createHash } from 'crypto';
import type { IExecuteFunctions } from 'n8n-workflow';

/**
 * The default Idempotency-Key (D14, AC3.11, AC6.3): `n8n-` plus the sha256 hex of
 * `<workflowId>:<executionId>:<node name>:<runIndex>:<suffix>`. Generate passes the item index; a
 * batch submission passes its own suffix. The run index (`$runIndex`, 0 when unavailable) makes
 * every run of the node within one execution (Loop Over Items, AI Agent tool calls) a separate
 * render. n8n's Retry On Fail retries within one run of one execution, so a retry sends the same
 * key and is not charged again; a re-run execution gets a new id and a new key. Undefined when
 * the execution id is not available, so no key is sent.
 */
export function idempotencyKey(
	this: Pick<IExecuteFunctions, 'getWorkflow' | 'getExecutionId' | 'getNode' | 'getWorkflowDataProxy'>,
	suffix: number | string,
): string | undefined {
	const executionId = this.getExecutionId();
	if (!executionId) return undefined;
	const proxyRunIndex: unknown = this.getWorkflowDataProxy(0).$runIndex;
	const runIndex = typeof proxyRunIndex === 'number' ? proxyRunIndex : 0;
	const source = `${this.getWorkflow().id ?? ''}:${executionId}:${this.getNode().name}:${runIndex}:${suffix}`;
	return `n8n-${createHash('sha256').update(source).digest('hex')}`;
}
