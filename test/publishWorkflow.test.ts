import { describe, expect, it } from 'vitest';
import workflow from '../.github/workflows/publish.yml?raw';

const lines = workflow.split('\n');
const header = lines
	.filter((line) => line.startsWith('#'))
	.join(' ')
	.replace(/#\s*/g, '')
	.replace(/\s+/g, ' ');
/** The workflow without its comments, so a commented-out line never counts. */
const active = lines.filter((line) => !/^\s*#/.test(line)).join('\n');

/** The index of the first active line that matches, or -1. */
function lineOf(pattern: RegExp): number {
	return lines.findIndex((line) => !/^\s*#/.test(line) && pattern.test(line));
}

describe('mirror publish workflow (AC1.7, E4, D-T14.1)', () => {
	it('runs on v* tags only', () => {
		expect(active).toMatch(/^on:\n\s+push:\n\s+tags:\n\s+- 'v\*'\n/m);
		expect(active).not.toMatch(/workflow_dispatch|pull_request|branches:/);
	});

	it('fails when the tag does not equal the package.json version', () => {
		expect(active).toMatch(/TAG: \$\{\{ github\.ref_name \}\}/);
		expect(active).toMatch(/VERSION=\$\(jq -r \.version package\.json\)/);
		expect(active).toMatch(/if \[ "\$TAG" != "v\$\{VERSION\}" \]; then[\s\S]*?exit 1/);
	});

	it('runs npm ci, lint, test, build and the scan before publishing', () => {
		const order = [
			/run: npm ci$/,
			/run: npm run lint$/,
			/run: npm test$/,
			/run: npm run build$/,
			/run: npm run scan$/,
			/run: npm publish --provenance --access public$/,
		].map(lineOf);
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('publishes with provenance through OIDC, passing NPM_TOKEN for the first publish', () => {
		expect(active).toMatch(/^permissions:\n(?:\s+.*\n)*?\s+id-token: write$/m);
		const publish = lineOf(/run: npm publish --provenance --access public$/);
		const env = active.slice(active.indexOf('npm publish --provenance --access public'));
		expect(publish).toBeGreaterThan(0);
		expect(env).toMatch(/^\s+NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}$/m);
		expect(lineOf(/npm install -g npm@\^11\.5\.1/)).toBeLessThan(publish);
	});

	it('says in its header how the first publish authenticates and when the token goes', () => {
		expect(header).toMatch(/Trusted Publisher only .*package that already exists/);
		expect(header).toMatch(/NPM_TOKEN secret\b.*before the first mirror run/);
		expect(header).toMatch(/after the first publish.*Trusted Publisher.*remove the NPM_TOKEN secret/i);
		expect(header).toMatch(/re-run the workflow on the same tag/);
		expect(header).toMatch(/bumping the patch version/);
	});
});
