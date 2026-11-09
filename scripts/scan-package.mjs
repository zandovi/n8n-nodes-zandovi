// Runs the checks of `npx @n8n/scan-community-package` against this package before it is
// published. That CLI only scans a version already on npm (it downloads the tarball and the
// source its provenance points at), so this script packs the package with `npm pack` and lints
// the same two legs with the scanner's own rule set: the source (package.json, nodes/,
// credentials/) and the packed tarball's compiled JavaScript. Run it after `npm run build`.
// Dev tooling only: it is not part of the published package.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	analyzePackage,
	SOURCE_FILE_PATTERNS,
} from '@n8n/scan-community-package/dist/scanner.js';
import packageJson from '../package.json' with { type: 'json' };

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(path.join(tmpdir(), 'zandovi-n8n-scan-'));

try {
	const packed = JSON.parse(
		execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
			cwd: root,
			encoding: 'utf8',
		}),
	);
	const tarball = path.join(work, packed[0].filename);
	execFileSync('tar', ['-xzf', tarball, '-C', work]);
	const unpacked = path.join(work, 'package');

	const declared = [...packageJson.n8n.nodes, ...packageJson.n8n.credentials];
	const missing = declared.filter((file) => !existsSync(path.join(unpacked, file)));
	if (missing.length > 0) {
		console.error(`The tarball lacks ${missing.join(', ')}; run npm run build first.`);
		process.exit(1);
	}

	const results = [
		['source', await analyzePackage(root, SOURCE_FILE_PATTERNS)],
		['tarball', await analyzePackage(unpacked, ['**/*.js', 'package.json'])],
	];
	let failed = false;
	for (const [leg, result] of results) {
		if (result.passed) {
			console.log(`Scan of the ${leg} passed`);
		} else {
			failed = true;
			console.error(`Scan of the ${leg} failed: ${result.message}`);
			if (result.details) console.error(result.details);
		}
	}
	process.exitCode = failed ? 1 : 0;
} finally {
	rmSync(work, { recursive: true, force: true });
}
