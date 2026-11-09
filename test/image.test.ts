import type { IBinaryData, IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Zandovi } from '../nodes/Zandovi/Zandovi.node';
import { imageResource } from '../nodes/Zandovi/resources/image';
import { executeItems } from '../nodes/Zandovi/shared/operations';
import { createContext, problem } from './helpers/context';
import type { FakeReply } from './helpers/context';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const ID = '0192c3f0-8d6a-7b1c-9f4e-2a5b6c7d8e9f';
const image = (id: string): IDataObject => ({
	id,
	uri: `zandovi://images/${id}`,
	name: 'logo.png',
});
const ok = (body: unknown): FakeReply => ({ statusCode: 200, body });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function binary(extra: Partial<IBinaryData> = {}): IBinaryData {
	return { data: '', mimeType: 'image/png', fileName: 'logo.png', ...extra };
}

function runUpload(options: {
	replies?: FakeReply[];
	parameters: IDataObject;
	binaryItem?: Record<string, IBinaryData>;
	buffer?: Buffer;
	continueOnFail?: boolean;
}) {
	const fake = createContext({
		replies: options.replies ?? [],
		items: [{ json: {}, binary: options.binaryItem }],
		parameters: { resource: 'image', operation: 'upload', options: {}, ...options.parameters },
		continueOnFail: options.continueOnFail,
	});
	const getBinaryDataBuffer = vi.fn(async () => options.buffer ?? PNG);
	(fake.context.helpers as unknown as IDataObject).getBinaryDataBuffer = getBinaryDataBuffer;
	return {
		...fake,
		getBinaryDataBuffer,
		result: executeItems.call(fake.context as IExecuteFunctions, [imageResource]),
	};
}

interface Part {
	name: string;
	fileName?: string;
	contentType?: string;
	data: Buffer;
}

/** Splits a multipart body on the boundary its Content-Type header names. */
function parseMultipart(body: unknown, contentType: unknown): Part[] {
	// The fake helper structured-clones the options, which turns a Buffer into a Uint8Array.
	expect(body).toBeInstanceOf(Uint8Array);
	const bytes = Buffer.from(body as Uint8Array);
	const match = /^multipart\/form-data; boundary=(\S+)$/.exec(String(contentType));
	expect(match).not.toBeNull();
	const text = bytes.toString('latin1');
	const delimiter = `--${match![1]}`;
	expect(text.endsWith(`${delimiter}--\r\n`)).toBe(true);
	return text
		.slice(0, text.length - `${delimiter}--\r\n`.length)
		.split(`${delimiter}\r\n`)
		.slice(1)
		.map((raw) => {
			const end = raw.indexOf('\r\n\r\n');
			const head = raw.slice(0, end);
			return {
				name: /name="([^"]*)"/.exec(head)![1],
				fileName: /filename="([^"]*)"/.exec(head)?.[1],
				contentType: /Content-Type: (.*)/i.exec(head)?.[1],
				data: Buffer.from(raw.slice(end + 4, raw.length - 2), 'latin1'),
			};
		});
}

beforeEach(() => {
	vi.mocked(sleep).mockClear();
});

describe('Image → Upload', () => {
	it('sends multipart POST /images with part "file", the binary file name and type, plus options (AC5.1, AC5.2, D-T5.1)', async () => {
		const run = runUpload({
			replies: [ok(image(ID))],
			parameters: {
				source: 'binary',
				binaryPropertyName: 'logo',
				options: { name: 'Brand logo', visibility: 'SHARED' },
			},
			binaryItem: { logo: binary({ fileName: 'brand.png' }) },
		});
		await run.result;
		expect(run.getBinaryDataBuffer).toHaveBeenCalledWith(0, 'logo');
		expect(run.calls).toHaveLength(1);
		const [call] = run.calls;
		expect(call.method).toBe('POST');
		expect(call.url).toBe('https://app.zandovi.com/api/v1/images');
		expect(call.json).toBe(true);
		const parts = parseMultipart(call.body, call.headers?.['Content-Type']);
		expect(parts.map((part) => part.name).sort()).toEqual(['file', 'name', 'visibility']);
		const file = parts.find((part) => part.name === 'file')!;
		expect(file.fileName).toBe('brand.png');
		expect(file.contentType).toBe('image/png');
		expect(file.data).toEqual(PNG);
		expect(parts.find((part) => part.name === 'name')!.data.toString()).toBe('Brand logo');
		expect(parts.find((part) => part.name === 'visibility')!.data.toString()).toBe('SHARED');
	});

	it('outputs the same shape for a fresh and a reused URL upload (AC5.3, E21, D-T11.2)', async () => {
		// The API answers a fresh upload 201 with reused: false and a reused URL image 200 with reused: true.
		const parameters = { source: 'url', url: 'https://example.com/a.png' };
		const [fresh] = await runUpload({
			replies: [{ statusCode: 201, body: { ...image(ID), reused: false } }],
			parameters,
		}).result;
		const [reused] = await runUpload({
			replies: [ok({ ...image(ID), reused: true })],
			parameters,
		}).result;
		const reference = `zandovi://images/${ID}`;
		expect(fresh).toEqual([
			{ json: { ...image(ID), reused: false, reference }, pairedItem: { item: 0 } },
		]);
		expect(reused).toEqual([
			{ json: { ...image(ID), reused: true, reference }, pairedItem: { item: 0 } },
		]);
		const keys = Object.keys(fresh[0].json).sort();
		expect(keys).toEqual(Object.keys(reused[0].json).sort());
		expect(keys).toEqual(expect.arrayContaining(['reference', 'reused']));
	});

	it('sends JSON { url } for the URL source (AC5.1)', async () => {
		const run = runUpload({
			replies: [ok(image(ID))],
			parameters: { source: 'url', url: 'https://example.com/a.png' },
		});
		const [output] = await run.result;
		expect(run.calls[0].body).toEqual({ url: 'https://example.com/a.png' });
		expect(run.calls[0].json).toBe(true);
		expect(output[0].json.reference).toBe(`zandovi://images/${ID}`);
	});

	it('rejects a binary over 5 MB without a request (AC5.4)', async () => {
		const run = runUpload({
			parameters: { source: 'binary', binaryPropertyName: 'data' },
			binaryItem: { data: binary() },
			buffer: Buffer.alloc(6 * 1024 * 1024),
		});
		await expect(run.result).rejects.toThrow('Image is 6.0 MB; the limit is 5 MB');
		expect(run.calls).toHaveLength(0);
	});

	it('rejects a type outside JPEG, PNG, GIF and WebP without a request (AC5.4)', async () => {
		const run = runUpload({
			parameters: { source: 'binary', binaryPropertyName: 'data' },
			binaryItem: { data: binary({ mimeType: 'image/svg+xml', fileName: 'a.svg' }) },
		});
		await expect(run.result).rejects.toThrow(
			'Unsupported image type image/svg+xml; use JPEG, PNG, GIF or WebP',
		);
		expect(run.calls).toHaveLength(0);
	});

	it.each([
		['missing', undefined, 'photo.JPG', undefined, 'image/jpeg'],
		['empty', '', 'photo.png', undefined, 'image/png'],
		['generic', 'application/octet-stream', 'anim.gif', undefined, 'image/gif'],
		['generic with a fileExtension', 'application/octet-stream', 'download', 'webp', 'image/webp'],
	])(
		'types a binary with a %s mimeType from its extension (E23, D-T11.3)',
		async (_label, mimeType, fileName, fileExtension, expected) => {
			const run = runUpload({
				replies: [ok(image(ID))],
				parameters: { source: 'binary', binaryPropertyName: 'data' },
				binaryItem: { data: binary({ mimeType, fileName, fileExtension }) },
			});
			await run.result;
			const [call] = run.calls;
			const file = parseMultipart(call.body, call.headers?.['Content-Type'])[0];
			expect(file.contentType).toBe(expected);
		},
	);

	it.each([
		['missing', undefined, 'notes.txt', 'unknown'],
		['empty', '', 'noextension', 'unknown'],
		['generic', 'application/octet-stream', 'data.bin', 'application/octet-stream'],
	])(
		'fails a %s mimeType with an unknown extension, without a request (E23, D-T11.3)',
		async (_label, mimeType, fileName, shown) => {
			const run = runUpload({
				parameters: { source: 'binary', binaryPropertyName: 'data' },
				binaryItem: { data: binary({ mimeType, fileName }) },
			});
			await expect(run.result).rejects.toThrow(
				`Unsupported image type ${shown}; use JPEG, PNG, GIF or WebP`,
			);
			expect(run.calls).toHaveLength(0);
		},
	);

	it('allows exactly 5 MiB and rejects 5 MiB + 1 byte (D-T11.4)', async () => {
		const limit = 5 * 1024 * 1024;
		const allowed = runUpload({
			replies: [ok(image(ID))],
			parameters: { source: 'binary', binaryPropertyName: 'data' },
			binaryItem: { data: binary() },
			buffer: Buffer.alloc(limit),
		});
		await allowed.result;
		expect(allowed.calls).toHaveLength(1);

		const rejected = runUpload({
			parameters: { source: 'binary', binaryPropertyName: 'data' },
			binaryItem: { data: binary() },
			buffer: Buffer.alloc(limit + 1),
		});
		await expect(rejected.result).rejects.toThrow('the limit is 5 MB');
		expect(rejected.calls).toHaveLength(0);
	});

	it('sends the full multipart body again when a 429 is retried (AC2.6, D-T11.1)', async () => {
		const run = runUpload({
			replies: [
				{
					statusCode: 429,
					headers: { 'retry-after': '1' },
					body: problem(429, 'RATE_LIMIT_EXCEEDED', 'slow down'),
				},
				ok(image(ID)),
			],
			parameters: { source: 'binary', binaryPropertyName: 'data' },
			binaryItem: { data: binary() },
		});
		await run.result;
		expect(run.calls).toHaveLength(2);
		for (const call of run.calls) {
			const file = parseMultipart(call.body, call.headers?.['Content-Type']).find(
				(part) => part.name === 'file',
			)!;
			expect(file.data).toEqual(PNG);
		}
		expect(run.calls[1].body).toEqual(run.calls[0].body);
		expect(run.calls[1].headers).toEqual(run.calls[0].headers);
	});

	it('names the item and field when the binary field is missing (AC5.5)', async () => {
		const run = runUpload({
			parameters: { source: 'binary', binaryPropertyName: 'picture' },
			binaryItem: { data: binary() },
		});
		await expect(run.result).rejects.toThrow("Input item 0 has no binary field 'picture'");
		expect(run.calls).toHaveLength(0);
	});

	it('names the missing scope on 403 (AC5.7)', async () => {
		const run = runUpload({
			replies: [
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'no', {
						details: { requiredScope: 'images:write' },
					}),
				},
			],
			parameters: { source: 'url', url: 'https://example.com/a.png' },
		});
		await expect(run.result).rejects.toThrow(
			'This API key lacks the `images:write` scope needed for Image → Upload; create a key that has it',
		);
	});

	it('waits out a short 429 and retries (AC5.7, E24)', async () => {
		const run = runUpload({
			replies: [
				{
					statusCode: 429,
					headers: { 'retry-after': '2' },
					body: problem(429, 'RATE_LIMIT_EXCEEDED', 'slow down'),
				},
				ok(image(ID)),
			],
			parameters: { source: 'url', url: 'https://example.com/a.png' },
		});
		await run.result;
		expect(run.calls).toHaveLength(2);
		expect(vi.mocked(sleep).mock.calls).toEqual([[2000, undefined]]);
	});
});

describe('Image → Get Many', () => {
	function runGetMany(replies: FakeReply[], parameters: IDataObject) {
		const fake = createContext({
			replies,
			parameters: { resource: 'image', operation: 'getMany', q: '', ...parameters },
		});
		return { ...fake, result: executeItems.call(fake.context, [imageResource]) };
	}

	it('follows nextCursor until done, one item per image with a reference (AC5.6)', async () => {
		const run = runGetMany(
			[
				ok({ items: [image('a'), image('b')], nextCursor: 'c1' }),
				ok({ items: [image('c')], nextCursor: null }),
			],
			{ returnAll: true, q: 'logo' },
		);
		const [output] = await run.result;
		expect(output.map((item) => item.json.reference)).toEqual([
			'zandovi://images/a',
			'zandovi://images/b',
			'zandovi://images/c',
		]);
		expect(run.calls.map((call) => call.qs)).toEqual([
			{ limit: 50, q: 'logo' },
			{ limit: 50, q: 'logo', cursor: 'c1' },
		]);
		expect(run.calls.every((call) => call.method === 'GET')).toBe(true);
	});

	it('stops at Limit and asks only for what is left (AC5.6)', async () => {
		const first = Array.from({ length: 50 }, (_, i) => image(`i${i}`));
		const second = Array.from({ length: 50 }, (_, i) => image(`j${i}`));
		const run = runGetMany(
			[
				ok({ items: first, nextCursor: 'c1' }),
				ok({ items: second.slice(0, 20), nextCursor: 'c2' }),
			],
			{ returnAll: false, limit: 70 },
		);
		const [output] = await run.result;
		expect(output).toHaveLength(70);
		expect(run.calls.map((call) => call.qs)).toEqual([{ limit: 50 }, { limit: 20, cursor: 'c1' }]);
	});

	it('names the missing scope on 403 (AC5.7)', async () => {
		const run = runGetMany(
			[
				{
					statusCode: 403,
					body: problem(403, 'INSUFFICIENT_SCOPE', 'no', {
						details: { requiredScope: 'images:read' },
					}),
				},
			],
			{ returnAll: false, limit: 5 },
		);
		await expect(run.result).rejects.toThrow('`images:read` scope needed for Image → Get Many');
	});
});

describe('Image resource fields (AC5.1, AC5.2, AC5.6)', () => {
	const properties = new Zandovi().description.properties;
	const field = (name: string, operation: string) =>
		properties.find(
			(property) =>
				property.name === name &&
				property.displayOptions?.show?.resource?.includes('image') &&
				property.displayOptions?.show?.operation?.includes(operation),
		) as INodeProperties;
	const optionValues = (property: INodeProperties) =>
		((property.options ?? []) as Array<{ value: string }>).map((option) => option.value);

	it('gives Upload a Source defaulting to Binary File, with URL as the other choice', () => {
		const source = field('source', 'upload');
		expect(source.default).toBe('binary');
		expect(optionValues(source)).toEqual(['binary', 'url']);
		expect((source.options as Array<{ name: string }>)[0].name).toBe('Binary File');
	});

	it('shows Input Binary Field (default data) for binary and Image URL for url only', () => {
		const binaryField = field('binaryPropertyName', 'upload');
		expect(binaryField.default).toBe('data');
		expect(binaryField.displayOptions?.show?.source).toEqual(['binary']);
		expect(field('url', 'upload').displayOptions?.show?.source).toEqual(['url']);
	});

	it('offers Name and a Visibility option defaulting to Private, with Shared as the other choice', () => {
		const options = (field('options', 'upload').options ?? []) as INodeProperties[];
		expect(options.map((option) => option.name)).toEqual(['name', 'visibility']);
		const visibility = options.find((option) => option.name === 'visibility')!;
		expect(visibility.default).toBe('PRIVATE');
		expect(optionValues(visibility)).toEqual(['PRIVATE', 'SHARED']);
	});

	it('gives Get Many Search, Return All off by default and a Limit of 50 within 1 to 500 shown only without Return All', () => {
		expect(field('q', 'getMany').default).toBe('');
		expect(field('returnAll', 'getMany').default).toBe(false);
		const limit = field('limit', 'getMany');
		expect(limit.default).toBe(50);
		expect(limit.typeOptions).toMatchObject({ minValue: 1, maxValue: 500 });
		expect(limit.displayOptions?.show?.returnAll).toEqual([false]);
	});
});
