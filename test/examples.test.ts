import type { INodeProperties } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import certificateExample from '../examples/certificate-pdf-from-sheets.json';
import couponExample from '../examples/coupon-per-new-customer.json';
import ogExample from '../examples/og-image-per-blog-post.json';
import checklist from '../RELEASE-CHECKLIST.md?raw';
import readme from '../README.md?raw';

const ZANDOVI_TYPE = '@zandovi/n8n-nodes-zandovi.zandovi';
const BUILT_IN_TYPES = new Set([
	'n8n-nodes-base.rssFeedReadTrigger',
	'n8n-nodes-base.stripeTrigger',
	'n8n-nodes-base.googleSheetsTrigger',
	'n8n-nodes-base.gmail',
	'n8n-nodes-base.googleDrive',
	'n8n-nodes-base.set',
	'n8n-nodes-base.httpRequest',
	'n8n-nodes-base.stickyNote',
]);

interface WorkflowNode {
	name: string;
	type: string;
	typeVersion: number;
	position: [number, number];
	parameters: Record<string, unknown>;
	credentials?: unknown;
}
interface Workflow {
	name: string;
	nodes: WorkflowNode[];
	connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

const EXAMPLES = [
	'og-image-per-blog-post.json',
	'coupon-per-new-customer.json',
	'certificate-pdf-from-sheets.json',
];
const SOURCES: Record<string, unknown> = {
	'og-image-per-blog-post.json': ogExample,
	'coupon-per-new-customer.json': couponExample,
	'certificate-pdf-from-sheets.json': certificateExample,
};

function load(file: string): Workflow {
	return SOURCES[file] as Workflow;
}

const properties = new Zandovi().description.properties;

/** The node's properties that are shown for a resource and operation (the Resource and Operation selectors always are). */
function propertiesFor(resource: string, operation: string): INodeProperties[] {
	return properties.filter((property) => {
		const show = property.displayOptions?.show ?? {};
		if (show.resource && !show.resource.includes(resource)) return false;
		if (show.operation && !show.operation.includes(operation)) return false;
		return true;
	});
}

function stickyText(workflow: Workflow): string {
	return workflow.nodes
		.filter((node) => node.type === 'n8n-nodes-base.stickyNote')
		.map((node) => String(node.parameters.content))
		.join('\n');
}

/** The only repository a mirrored file may name, and the hosts it may mention. */
const PUBLIC_REPOSITORY = 'zandovi/n8n-nodes-zandovi';
const ALLOWED_HOSTS = ['zandovi.com', 'n8n.io', 'npmjs.com', 'github.com', 'example.com', 'localhost'];
const REPOSITORY_WORDS = new Set(['the', 'a', 'an', 'public', 'source', 'this', 'its', 'your', 'same', 'git', 'github']);

/** Repository and host references in a mirrored file that are not on the allowlist above. */
function foreignReferences(text: string): string[] {
	const found: string[] = [];
	const allowedHost = (host: string) =>
		ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
	for (const [, host] of text.matchAll(/\b(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?([^/:\s`'")\\]+)/gi)) {
		if (!allowedHost(host.toLowerCase())) found.push(host);
	}
	for (const [host] of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|sh|ai|eu|pl|de)\b/gi)) {
		if (!allowedHost(host.toLowerCase())) found.push(host);
	}
	for (const [, slug] of text.matchAll(/github\.com[/:]([\w.-]+\/[\w.-]+)/gi)) {
		if (slug.replace(/\.git$/, '') !== PUBLIC_REPOSITORY) found.push(slug);
	}
	for (const [, before, after] of text.matchAll(/(\S+)\s+repo(?:sitory|sitories|s)?\b(?:'s)?(?:\s+(\S+))?/gi)) {
		const word = before.replace(/[`'"*_()[\]]/g, '').toLowerCase();
		if (!REPOSITORY_WORDS.has(word) && word !== PUBLIC_REPOSITORY) found.push(before);
		const next = (after ?? '').replace(/[`'"*()[\],.:;]+$|^[`'"*()[\]]+/g, '');
		if (/[/-]/.test(next) && !/\.\w+$/.test(next) && next !== PUBLIC_REPOSITORY) found.push(next);
	}
	return found;
}

describe('foreign reference detector', () => {
	it('accepts the public repository and the allowed hosts', () => {
		expect(
			foreignReferences(
				'the public repository is `zandovi/n8n-nodes-zandovi` at https://github.com/zandovi/n8n-nodes-zandovi; see https://mcp.zandovi.com/mcp and creators.n8n.io',
			),
		).toEqual([]);
	});

	it.each([
		'see the acme-infra repo for the manifests',
		'deployed from the repository acme/cluster-config',
		'https://github.com/acme/private-monorepo',
		'git@github.com:acme/private-monorepo.git',
		'dashboards live on grafana.acme-hosting.net',
		'https://metrics.internal.example.org/d/abc',
	])('flags %s', (text) => {
		expect(foreignReferences(text)).not.toEqual([]);
	});
});

describe.each(EXAMPLES)('example workflow %s (AC9.2, AC9.3, D-T9.2)', (file) => {
	it('exists and uses only the Zandovi node and built-in n8n nodes, with no credentials set', () => {
		const workflow = load(file);
		for (const node of workflow.nodes) {
			expect(
				node.type === ZANDOVI_TYPE || BUILT_IN_TYPES.has(node.type),
				`${node.name}: ${node.type}`,
			).toBe(true);
			expect(node.credentials, `${node.name} ships without credentials (E38)`).toBeUndefined();
		}
		const names = workflow.nodes.map((node) => node.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('connects only nodes that exist', () => {
		const workflow = load(file);
		const names = new Set(workflow.nodes.map((node) => node.name));
		for (const [from, connection] of Object.entries(workflow.connections)) {
			expect(names.has(from), from).toBe(true);
			for (const target of connection.main.flat())
				expect(names.has(target.node), target.node).toBe(true);
		}
	});

	it('gives every Zandovi node only parameters its operation defines, with valid option values', () => {
		const workflow = load(file);
		const zandoviNodes = workflow.nodes.filter((node) => node.type === ZANDOVI_TYPE);
		expect(zandoviNodes.length).toBeGreaterThan(0);
		for (const node of zandoviNodes) {
			expect(node.typeVersion).toBe(1);
			const { resource, operation } = node.parameters as { resource: string; operation: string };
			const defined = propertiesFor(resource, operation);
			const resourceProperty = properties.find((property) => property.name === 'resource');
			expect(
				resourceProperty?.options?.map((option) => (option as { value: string }).value),
			).toContain(resource);
			const operationProperty = properties.find(
				(property) =>
					property.name === 'operation' &&
					property.displayOptions?.show?.resource?.includes(resource),
			);
			expect(
				operationProperty?.options?.map((option) => (option as { value: string }).value),
				`${node.name} operation`,
			).toContain(operation);
			for (const [name, value] of Object.entries(node.parameters)) {
				const property = defined.find((candidate) => candidate.name === name);
				expect(property, `${node.name}: unknown parameter ${name}`).toBeDefined();
				if (property?.type === 'options' && property.options) {
					expect(
						property.options?.map((option) => (option as { value: unknown }).value),
						`${node.name}.${name}`,
					).toContain(value);
				}
				if (property?.type === 'collection') {
					const known = (property.options ?? []).map((option) => (option as { name: string }).name);
					for (const key of Object.keys(value as object)) {
						expect(known, `${node.name}.${name}.${key}`).toContain(key);
					}
				}
			}
			// Every required parameter of the operation is present.
			for (const property of defined) {
				const shown = Object.entries(property.displayOptions?.show ?? {}).every(
					([key, allowed]) =>
						key === 'resource' ||
						key === 'operation' ||
						key.startsWith('/') ||
						(allowed as unknown[]).includes(node.parameters[key]),
				);
				if (
					shown &&
					property.required &&
					property.type !== 'resourceMapper' &&
					property.type !== 'resourceLocator'
				) {
					expect(
						node.parameters[property.name],
						`${node.name} sets ${property.name}`,
					).toBeDefined();
				}
			}
		}
	});

	it('carries sticky notes naming the API key scopes and the starter', () => {
		const text = stickyText(load(file));
		expect(text).toMatch(/scopes?/i);
		expect(text).toMatch(/templates:read/);
		expect(text).toMatch(/\brender\b/);
		expect(text).toMatch(/starter-variables/);
	});

	it('names no repository but the public one and no host off the allowlist', () => {
		const text = JSON.stringify(load(file), null, 1).replace(/\\n/g, '\n');
		expect(foreignReferences(text)).toEqual([]);
	});
});

const STARTERS: Record<string, string> = {
	'og-image-per-blog-post.json': 'open-graph-starter-variables',
	'coupon-per-new-customer.json': 'coupon-starter-variables',
	'certificate-pdf-from-sheets.json': 'certificate-starter-variables',
};

function generateNodeOf(workflow: Workflow): WorkflowNode {
	return workflow.nodes.find(
		(node) => node.type === ZANDOVI_TYPE && node.parameters.operation === 'generate',
	)!;
}

/** The nodes whose main output feeds the named node. */
function sourcesOf(workflow: Workflow, name: string): WorkflowNode[] {
	const sources = Object.entries(workflow.connections)
		.filter(([, connection]) => connection.main.flat().some((target) => target.node === name))
		.map(([from]) => from);
	return workflow.nodes.filter((node) => sources.includes(node.name));
}

describe.each(EXAMPLES)('example %s keeps its Variables mapping through setup (G1)', (file) => {
	it('feeds Generate from a Create From Library node for its starter, with Reuse Existing Copy on', () => {
		const workflow = load(file);
		const generate = generateNodeOf(workflow);
		const sources = sourcesOf(workflow, generate.name);
		expect(sources).toHaveLength(1);
		expect(sources[0].type).toBe(ZANDOVI_TYPE);
		expect(sources[0].parameters).toMatchObject({
			resource: 'template',
			operation: 'createFromLibrary',
			libraryTemplateId: STARTERS[file],
			reuseExisting: true,
		});
	});

	it("takes Template By ID from the copy's id, so the user never edits the field the mapper depends on", () => {
		const generate = generateNodeOf(load(file));
		expect(generate.parameters.templateId).toEqual({
			__rl: true,
			mode: 'id',
			value: '={{ $json.id }}',
		});
		const variables = (generate.parameters.variables as { value: Record<string, string> }).value;
		expect(Object.keys(variables).length).toBeGreaterThan(0);
		// $json in Generate is the template copy, so trigger data must be read by node name.
		for (const [name, value] of Object.entries(variables)) {
			expect(value, `${name} reads the trigger, not the template copy`).not.toMatch(/\$json\b/);
		}
	});

	it('does not tell the user to paste a template ID', () => {
		expect(stickyText(load(file))).not.toMatch(/paste|template'?s? ID into/i);
	});
});

describe('example specifics (AC9.2, AC9.3)', () => {
	it('og-image: RSS trigger, Share Link generate with the OG variables, a write-back node, expiry warning', () => {
		const workflow = load('og-image-per-blog-post.json');
		expect(workflow.nodes.map((node) => node.type)).toContain('n8n-nodes-base.rssFeedReadTrigger');
		const generate = generateNodeOf(workflow);
		expect(generate.parameters).toMatchObject({
			resource: 'template',
			operation: 'generate',
			delivery: 'link',
		});
		const variables = (generate.parameters.variables as { value: Record<string, string> }).value;
		expect(Object.keys(variables)).toEqual(
			expect.arrayContaining(['og_title', 'og_subtitle', 'author_name', 'site_name']),
		);
		expect(
			workflow.nodes.some(
				(node) => node.type === 'n8n-nodes-base.set' || node.type === 'n8n-nodes-base.httpRequest',
			),
		).toBe(true);
		expect(stickyText(workflow)).toMatch(/at most 7 days on the free plan/);
		expect(stickyText(workflow)).not.toMatch(/7 days by default/);
		expect(stickyText(workflow)).toContain('open-graph-starter-variables');
	});

	it('coupon: Stripe customer.created, Create From Library with reuse on, binary generate with the QR variable, Gmail attachment', () => {
		const workflow = load('coupon-per-new-customer.json');
		const stripe = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.stripeTrigger')!;
		expect(stripe.parameters.events).toEqual(['customer.created']);
		const library = workflow.nodes.find(
			(node) => node.type === ZANDOVI_TYPE && node.parameters.operation === 'createFromLibrary',
		)!;
		expect(library.parameters).toMatchObject({
			libraryTemplateId: 'coupon-starter-variables',
			reuseExisting: true,
		});
		const generate = workflow.nodes.find(
			(node) => node.type === ZANDOVI_TYPE && node.parameters.operation === 'generate',
		)!;
		expect(generate.parameters.delivery).toBe('binary');
		expect(Object.keys((generate.parameters.variables as { value: object }).value)).toContain(
			'redeem_url',
		);
		const gmail = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.gmail')!;
		expect(JSON.stringify(gmail.parameters)).toContain(
			String(generate.parameters.binaryPropertyName),
		);
		expect(workflow.connections['Stripe Trigger'].main[0][0].node).toBe(library.name);
		expect(workflow.connections[library.name].main[0][0].node).toBe(generate.name);
		expect(workflow.connections[generate.name].main[0][0].node).toBe(gmail.name);
		expect(stickyText(workflow)).toContain('templates:write');
	});

	it('certificate: Sheets rowAdded, PDF generate named from the recipient, Gmail and Drive both fed', () => {
		const workflow = load('certificate-pdf-from-sheets.json');
		const trigger = workflow.nodes.find(
			(node) => node.type === 'n8n-nodes-base.googleSheetsTrigger',
		)!;
		expect(trigger.parameters.event).toBe('rowAdded');
		const generate = generateNodeOf(workflow);
		expect(generate.parameters).toMatchObject({ operation: 'generate', format: 'pdf' });
		const options = generate.parameters.options as { fileName: string };
		// The recipient's name, trimmed, with a non-empty fallback when the cell is empty or blank.
		const fileName = /^=\{\{ \(String\(\$\('Google Sheets Trigger'\)\.item\.json\['Recipient Name'\] \?\? ''\)\.trim\(\) \|\| '([^']+)'\) \+ ' certificate' \}\}$/.exec(
			options.fileName,
		);
		expect(fileName, options.fileName).not.toBeNull();
		expect(fileName![1].trim()).not.toBe('');
		const targets = workflow.connections[generate.name].main[0].map((target) => target.node);
		const types = workflow.nodes
			.filter((node) => targets.includes(node.name))
			.map((node) => node.type);
		expect(types.sort()).toEqual(['n8n-nodes-base.gmail', 'n8n-nodes-base.googleDrive']);
	});
});

describe('release checklist (AC9.1, D-T9.1)', () => {
	const boxes = checklist.split('\n').filter((line) => /^- \[[ x]\] /.test(line));

	it.each([
		['AC8.1 MCP check', /AC8\.1/],
		['npm provenance', /provenance/i],
		['n8n Cloud install', /n8n Cloud/],
		['self-hosted install', /self-hosted/i],
		['example import and Variables mapping', /import each file in `examples\/`.*Variables mapping/],
		['tool-mode smoke test', /AC3\.16/],
		['creators.n8n.io submission', /creators\.n8n\.io/],
		['template URLs', /n8n\.io URL/i],
		['blog update', /blog/i],
		['docs-site page', /docs-site|docs site/i],
		['A1', /\bA1\b/],
		['A2', /\bA2\b/],
		['A4', /\bA4\b/],
		['A5', /\bA5\b/],
		['A5 on an AI Agent tool', /\bA5\b.*AI Agent.*2\.x.*new run index.*render twice.*Agent version/],
		['A6 and E35', /E35/],
		['A7', /\bA7\b/],
		['AC8.2', /AC8\.2/],
		['AC8.3', /AC8\.3/],
		['mirror setup', /Mirror setup.*deploy key.*ZANDOVI_N8N_NODE_DEPLOY_KEY/],
		['first mirror run', /First mirror run.*`v<version>` tag.*re-run with no change/],
		['live credential test', /Live credential test.*wrong API key.*non-Zandovi Base URL/],
		['User-Agent in the API metrics', /zandovi-n8n\/<version>.*API metrics/],
		['icons in light and dark', /icons are legible in the light and the dark theme/],
		['Callback URL + Wait flow', /Callback URL \+ Wait.*E26.*FAILED/],
		['Loop Over Items', /Loop Over Items \(batch size 2\).*5 items creates 3 jobs/],
		['two renders in one agent turn', /Two renders in one AI Agent turn/],
		['Create From Library then Generate by ID expression', /Create From Library → Generate.*By ID as an expression/],
	])('has a checkbox for %s', (_label, pattern) => {
		expect(boxes.some((line) => pattern.test(line))).toBe(true);
	});

	it('puts the MCP checks in a Phase 0 section before the node release (D-T13.1)', () => {
		const lines = checklist.split('\n');
		const phase0 = lines.findIndex((line) => /^## Phase 0/.test(line));
		const firstPublish = lines.findIndex((line) => /^## Before the first publish/.test(line));
		expect(phase0).toBeGreaterThanOrEqual(0);
		expect(phase0).toBeLessThan(firstPublish);
		const section = lines.slice(phase0, firstPublish).join('\n');
		for (const id of ['AC8.1', 'AC8.2', 'AC8.3', 'E35', 'A6']) expect(section).toContain(id);
		expect(section).toMatch(/MCP section.*only.*node sections unpublished/i);
		const after = lines.slice(firstPublish).join('\n');
		expect(after).not.toMatch(/MCP Client Tool on (n8n Cloud|self-hosted)/);
	});

	it('publishes the docs page node sections and the post-verification blog edit only after the node is verified (D-T13.1)', () => {
		const lines = checklist.split('\n');
		const step = (pattern: RegExp) =>
			lines.flatMap((line, index) => (/^- \[[ x]\] /.test(line) && pattern.test(line) ? [index] : []));
		const [submitted] = step(/creators\.n8n\.io submission/);
		const [verified] = step(/n8n Cloud install and run/);
		const nodeSections = step(/node sections/).filter((index) => !/unpublished/.test(lines[index]));
		expect(nodeSections).toHaveLength(1);
		expect(nodeSections[0]).toBeGreaterThan(verified);
		const [inReview] = step(/blog.*community node in review/i);
		const [installSteps] = step(/blog.*node install steps/i);
		expect(inReview).toBeGreaterThan(submitted);
		expect(installSteps).toBeGreaterThan(verified);
	});

	it('sets up a stage-only NPM_TOKEN before the first mirror run, approves the staged version, and adds the Trusted Publisher after the first publish (D-T14.1, D-T14.2)', () => {
		const lines = checklist.split('\n');
		const step = (pattern: RegExp) =>
			lines.findIndex((line) => /^- \[[ x]\] /.test(line) && pattern.test(line));
		const npmAuth = step(/npm auth.*`NPM_TOKEN` secret.*public repository.*before the first mirror run/i);
		const firstRun = step(/First mirror run/);
		const approve = step(/Approve the staged version with 2FA/);
		const firstPublished = lines.findIndex((line) => /^## After the first publish/.test(line));
		const trustedPublisher = step(/\bA7\b.*Trusted Publisher/);
		expect(npmAuth).toBeGreaterThanOrEqual(0);
		expect(npmAuth).toBeLessThan(firstRun);
		expect(lines[npmAuth]).toMatch(/Read and write \(stage only\)/);
		expect(lines[npmAuth]).toMatch(/npm stage publish/);
		expect(lines[firstRun]).toMatch(/start it manually/i);
		expect(approve).toBeGreaterThan(firstRun);
		expect(approve).toBeLessThan(firstPublished);
		expect(trustedPublisher).toBeGreaterThan(firstPublished);
		expect(lines[trustedPublisher]).toMatch(/direct `npm publish` off/);
		expect(lines[trustedPublisher]).toMatch(/remove the `NPM_TOKEN` secret/);
	});

	it('names no private repository and no file that exists only outside the package', () => {
		expect(foreignReferences(checklist)).toEqual([]);
		expect(checklist).not.toMatch(/bugs\.md|future-features\.md|docs\/plans/);
		const workflowFiles = [...checklist.matchAll(/[\w.-]+\.ya?ml\b/g)].map(([name]) => name);
		expect(workflowFiles.filter((name) => name !== 'publish.yml')).toEqual([]);
	});
});

describe('README example workflows (D-T9.3)', () => {
	it('links the three files and says the n8n.io links come after verification', () => {
		expect(readme).not.toContain('<!-- section: Example workflows -->');
		for (const file of EXAMPLES) expect(readme).toContain(`examples/${file}`);
		expect(readme).toMatch(/n8n\.io template links are added after/i);
	});

	it('names no repository but the public one and no host off the allowlist', () => {
		expect(foreignReferences(readme)).toEqual([]);
	});
});

describe('README accuracy (QA pass 2)', () => {
	const paragraphs = readme.split(/\n\s*\n/);
	const section = (heading: string) => {
		const start = readme.indexOf(`\n${heading}\n`);
		const end = readme.indexOf('\n## ', start + heading.length + 2);
		return readme.slice(start, end < 0 ? undefined : end);
	};

	it('qualifies every free or same-run Retry On Fail statement for AI Agent 2.x tool calls (D-T14.4)', () => {
		const retryClaims = paragraphs.filter(
			(paragraph) =>
				/Retry On Fail/.test(paragraph) &&
				/free|same run|charges once|charged once|not charge/i.test(paragraph),
		);
		expect(retryClaims.length).toBeGreaterThanOrEqual(3);
		for (const paragraph of retryClaims)
			expect(paragraph).toMatch(/AI Agent.*\b2\.x\b.*new run index.*(render|submit)s? .*again/s);
	});

	it('keeps Wait for Completion on inside Loop Over Items, because two batch jobs may run at once (D-T14.3)', () => {
		const batch = section('## Batch Job operations');
		expect(batch).toMatch(
			/Loop Over Items[^\n]*keep \*\*Wait for Completion\*\* on[^\n]*two batch jobs[^\n]*third/,
		);
	});

	it('says a project shared by another member cannot receive a library copy (D-T14.5)', () => {
		const library = section('### Create From Library');
		expect(library).toMatch(/your own projects/);
		expect(library).toMatch(/shared by another member.*`403`/);
	});
});
