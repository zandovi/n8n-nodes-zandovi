import { randomBytes } from 'node:crypto';

export interface MultipartFile {
	/** The form field name of the file part. */
	field: string;
	fileName: string;
	contentType: string;
	data: Buffer;
}

export interface MultipartBody {
	body: Buffer;
	contentType: string;
}

/** A header-safe form of a name: no quotes or line breaks that could end the header early. */
function headerSafe(value: string): string {
	return value.replace(/"/g, '%22').replace(/[\r\n]+/g, ' ');
}

/**
 * A complete `multipart/form-data` body as one Buffer, with the Content-Type that carries its
 * boundary (D-T11.1). n8n's request helper only recognises the `form-data` package's FormData,
 * which the node may not depend on, and sends a Buffer body as it is, so the bytes and the
 * header are built here. A Buffer is not consumed by a request, so a retry sends it in full.
 */
export function buildMultipart(
	file: MultipartFile,
	fields: Record<string, string>,
): MultipartBody {
	const boundary = `----zandovi-n8n-${randomBytes(12).toString('hex')}`;
	const chunks: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		chunks.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(name)}"\r\n\r\n${value}\r\n`,
				'utf8',
			),
		);
	}
	chunks.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${headerSafe(file.field)}"; filename="${headerSafe(file.fileName)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
			'utf8',
		),
		file.data,
		Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
	);
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
