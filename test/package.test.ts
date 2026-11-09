import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { ZandoviApi } from '../credentials/ZandoviApi.credentials';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import { buildProperties } from '../nodes/Zandovi/shared/operations';
import packageJson from '../package.json';
import { normalizeBaseUrl } from '../nodes/Zandovi/transport/request';
import { probeResource } from './helpers/context';

const DOCS_PAGE = 'https://docs.zandovi.com/integrations/n8n/';

/** One sentence: text with no sentence break inside and no trailing period (n8n's lint style). */
function expectOneSentence(text: unknown, what: string) {
	expect(typeof text === 'string' && text.trim().length > 0, `${what} has a description`).toBe(
		true,
	);
	expect(text as string, `${what} is one sentence`).not.toMatch(/[.!?]\s+\S|[.!?]$/);
}

describe('package.json (AC1.1, AC1.2)', () => {
	it('has the published identity and exactly one credential and one node', () => {
		expect(packageJson.name).toBe('@zandovi/n8n-nodes-zandovi');
		expect(packageJson.license).toBe('MIT');
		expect(packageJson.keywords).toContain('n8n-community-node-package');
		expect(packageJson.repository.url).toBe('https://github.com/zandovi/n8n-nodes-zandovi.git');
		expect(packageJson.n8n).toMatchObject({
			n8nNodesApiVersion: 1,
			credentials: ['dist/credentials/ZandoviApi.credentials.js'],
			nodes: ['dist/nodes/Zandovi/Zandovi.node.js'],
		});
	});

	it('uses @n8n/node-cli 0.23.0 or later and has no runtime dependencies', () => {
		const [major, minor] = packageJson.devDependencies['@n8n/node-cli']
			.replace(/^[^\d]*/, '')
			.split('.')
			.map(Number);
		expect(major > 0 || minor >= 23).toBe(true);
		expect(Object.keys((packageJson as { dependencies?: object }).dependencies ?? {})).toEqual([]);
	});
});

describe('ZandoviApi credential (AC2.1–AC2.3, AC1.10)', () => {
	const credential = new ZandoviApi();

	it('has a required password API Key and a Base URL defaulting to app.zandovi.com', () => {
		expect(credential.name).toBe('zandoviApi');
		expect(credential.properties).toEqual([
			expect.objectContaining({
				displayName: 'API Key',
				name: 'apiKey',
				type: 'string',
				typeOptions: { password: true },
				required: true,
			}),
			expect.objectContaining({
				displayName: 'Base URL',
				name: 'baseUrl',
				type: 'string',
				default: 'https://app.zandovi.com',
			}),
		]);
		for (const property of credential.properties)
			expectOneSentence(property.description, property.name);
	});

	it('points to the docs-site n8n page and ships light and dark icons', () => {
		expect(credential.documentationUrl).toBe(DOCS_PAGE);
		expect(credential.icon).toEqual({ light: 'file:zandovi.svg', dark: 'file:zandovi.dark.svg' });
	});

	it('authenticates with X-Api-Key only, never Authorization', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } },
		});
	});

	it('tests GET <Base URL>/api/v1/account, with the 401 message', () => {
		expect(credential.test.request).toMatchObject({ url: '/api/v1/account', method: 'GET' });
		expect(credential.test.rules).toEqual([
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'Invalid or revoked API key. Create one under Settings → API Keys.',
				},
			},
		]);
	});

	it.each([
		['https://app.zandovi.com', 'https://app.zandovi.com'],
		['https://app.zandovi.com/', 'https://app.zandovi.com'],
		['https://app.zandovi.com/api/v1', 'https://app.zandovi.com'],
		['https://app.zandovi.com/api/v1/', 'https://app.zandovi.com'],
		['https://app.zandovi.com/API/V1', 'https://app.zandovi.com'],
		['https://proxy.example.com/zandovi/', 'https://proxy.example.com/zandovi'],
		['https://proxy.example.com/zandovi/api/v1/', 'https://proxy.example.com/zandovi'],
		['', 'https://app.zandovi.com'],
	])(
		'normalises %j in the test request like the request layer (E5, D-T10.2)',
		(baseUrl, expected) => {
			const [, expression] = String(credential.test.request.baseURL).match(/^=\{\{(.+)\}\}$/) ?? [];
			expect(expression).toBeDefined();
			// Replay the expression: the fallback literal, then each `.replace(/<pattern>/<flags>, "")`.
			const fallback = expression.match(/\|\| "([^"]+)"\)/)?.[1];
			let evaluated = baseUrl || fallback || '';
			for (const [, pattern, flags] of expression.matchAll(/\.replace\(\/(.+?)\/(\w*), ""\)/g))
				evaluated = evaluated.replace(new RegExp(pattern, flags), '');
			expect(evaluated).toBe(expected);
			expect(evaluated).toBe(normalizeBaseUrl(baseUrl));
		},
	);
});

describe('Zandovi node (AC2.13, AC1.10, D-T2.2)', () => {
	const { description } = new Zandovi();

	it('is usable as a tool, uses the Zandovi credential and ships light and dark icons', () => {
		expect(description.usableAsTool).toBe(true);
		expect(description.credentials).toEqual([{ name: 'zandoviApi', required: true }]);
		expect(description.icon).toEqual({ light: 'file:zandovi.svg', dark: 'file:zandovi.dark.svg' });
		expectOneSentence(description.description, 'the node');
	});

	it('gives every resource, operation and field a one-sentence description', () => {
		const properties = [...description.properties, ...buildProperties([probeResource])];
		for (const property of properties) {
			expectOneSentence(property.description, property.name);
			for (const option of (property.options ?? []) as Array<{
				name: string;
				description?: string;
			}>) {
				expectOneSentence(option.description, `${property.name} option ${option.name}`);
			}
		}
	});

	it('shows each operation field only for its resource and operation', () => {
		const properties = buildProperties([probeResource]);
		const byName = (name: string) => properties.filter((property) => property.name === name);
		expect(byName('resource')[0]).toMatchObject({
			type: 'options',
			default: 'probe',
			options: [{ name: 'Probe', value: 'probe', description: probeResource.description }],
		});
		expect(byName('operation')[0]).toMatchObject({
			default: 'get',
			displayOptions: { show: { resource: ['probe'] } },
			options: [
				{
					name: 'Get',
					value: 'get',
					action: 'Get a probe',
					description: 'Read one probe by its ID',
				},
			],
		});
		expect(byName('probeId')[0].displayOptions).toEqual({
			show: { resource: ['probe'], operation: ['get'] },
		} satisfies INodeProperties['displayOptions']);
	});
});
