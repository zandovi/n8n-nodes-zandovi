# Zandovi node for n8n

This is an n8n community node for [Zandovi](https://zandovi.com), the image generation API with a real design editor. It renders your Zandovi templates with variable values from your workflow and returns the image as a binary file or a share link, uploads images for templates to use, and runs batch jobs that render many images at once.

## Installation

**n8n Cloud.** Open the nodes panel, search for "Zandovi" and pick it under "More from the community". Installing community nodes needs the owner or admin role, and the node appears there once n8n has verified it.

**Self-hosted.** Go to Settings → Community nodes → Install, enter `@zandovi/n8n-nodes-zandovi`, accept the risk prompt and install.

## Credentials

Create an API key in Zandovi under Settings → API Keys (app.zandovi.com), then add a **Zandovi API** credential in n8n and paste the key. Leave Base URL at `https://app.zandovi.com` (a trailing `/api/v1` is ignored). The Base URL must be an `https://` address without a user name, password, query or fragment; `http://` is accepted only for `localhost` during local development. The node never follows a redirect, so the API key is only ever sent to the Base URL.

Give the key the scopes the operations you use need:

| Operation | Scopes |
|---|---|
| Template: Get, Get Many | `templates:read` |
| Template: Generate | `templates:read` and `render` (the minimum for most workflows) |
| Template: Create From Library | `templates:write` |
| Image: Upload | `images:write` |
| Image: Get Many | `images:read` |
| Batch Job: Submit | `render` and `templates:read` |
| Batch Job: Get, Get Items, Get Result, Cancel | `render` |

A key that lacks a scope fails the operation with a message naming the missing scope.

## Template operations

**Get** and **Get Many** need the `templates:read` scope; **Generate** needs `templates:read` and `render`; **Create From Library** needs `templates:write`.

### Generate

Renders one template per input item and returns the image as a binary file or a share link. N input items give N output items, in the same order, each paired to its input item.

- **Template**: in **From List** mode, choose a **Project**, then a template from that project (the search box filters by name). In **By ID** mode, enter the template's UUID or map it with an expression; anything else fails with "Enter a template ID (UUID)".
- **Variables**: one field per template variable, labelled with its label (or its name when it has none) followed by the template's default value, for example `Recipient Name (default: Ana Silva)` (a long default is shortened with an ellipsis), and marked required only when the variable is required and has no default. Number variables get a number field, variables with a fixed list of values get a dropdown, every other variable gets a text field. Image variables take a public `https://` URL or the `zandovi://images/{id}` reference from **Image → Upload**; QR code and barcode variables take the value the code encodes; date variables take a date written `YYYY-MM-DD` (Zandovi refuses any other form and prints it as given), and email, URL and phone variables must be valid of their kind. Fields are not pre-filled: a field left empty is not sent, so the template's default renders, and a required variable left with no value and no default fails with Zandovi's message naming it. Every value is sent as text (numbers as written, booleans as `true` or `false`). Use **Refresh** in the Variables menu after changing the template's variables; a value mapped to a variable the template no longer has is still sent and is reported in `unknownVariables`.
- **Delivery**: **Binary File** (default) puts the file in the binary field named by **Put Output File in Field** (default `data`), with JSON `{ templateId, fileName, mimeType, fileSize, format, unknownVariables, idempotencyReplayed, quotaRemaining }`. **Share Link** returns no binary; its JSON is the API's share link (`url`, `expiresAt`, `fileName`, …) plus `templateId`, `unknownVariables`, `idempotencyReplayed` and `quotaRemaining`.
- **Format**: PNG (default), JPEG, WebP or PDF.
- **Options**: **File Name** (Zandovi adds the format's extension; without it, the name is the template name plus a short random suffix), **Output DPI** (Screen 96, Draft 150, Print 300), **Scale** (1–4; use either Output DPI or Scale, not both), **Quality** (1–100, JPEG and WebP), **Background Color**, **Link Expiry (Days)** (Share Link only) and **Idempotency Key**.

**Idempotency.** Each render sends an `Idempotency-Key` header of `n8n-` plus the SHA-256 of the workflow ID, execution ID, node name, run index (n8n's `$runIndex` for the node) and item index. When n8n's **Retry On Fail** retries a render whose response was lost (for example after a timeout), the retry runs within the same run, carries the same key, and Zandovi charges once: a binary file is rendered again for free with `idempotencyReplayed: true`, and a share link comes back as the same URL. That holds for a Zandovi node in the workflow itself; for Generate used as an **AI Agent** tool it depends on the Agent version: in older AI Agent versions (2.x) a retried tool call can get a new run index, so it gets a new key and renders again and is charged again. Each pass of a **Loop Over Items** loop and each **AI Agent** tool call is a new run of the node, so it is a separate render and is charged. **Re-running an execution gives it a new execution ID, so it renders and is charged again.** A non-empty **Idempotency Key** option is sent as it is instead. With several input items, give it an expression that differs per item, such as `{{ $json.id }}`: when items that render different content would share one key, the node fails those items before rendering any of them. Zandovi rejects a key longer than 255 characters or with non-visible ASCII characters, and a key reused with different inputs.

**Private projects.** The project list and the templates the key can use are the key owner's own projects and the projects other members of the organization have shared. Templates in another member's PRIVATE project are not visible to the key, so a member with no projects of their own and none shared sees an empty project list. That is expected.

### Get

Takes the same **Template** field as Generate and outputs the template's details from `GET /api/v1/templates/{id}`, including its `variables`.

### Get Many

Lists the templates in the required **Project**, one output item per template. With **Return All** off (the default) it returns up to **Limit** templates (default 50, at most 500); with it on, every template in the project.

### Create From Library

Copies one of the seven starter templates that have variables (Starter Coupon, Starter Gift Card, Starter Event Ticket, Starter Certificate, Starter OG Image, Product Spotlight and Guest Spotlight) into your account. Pick it from the **Library Template** list, which the node reads live from `<Base URL>/library/index.json`. Needs the `templates:write` scope. Options: **Project** (optional; its first entry, **Default (Your Oldest Project)**, leaves it empty, which means your oldest project, or a new "My first project") and **Reuse Existing Copy**. After that entry, the Project list shows every project the key can see, but the copy can only go into one of your own projects: a project shared by another member is refused with a `403`, and the node says so.

**Reuse Existing Copy** is on by default: if you already have a copy, the node returns it instead of creating another, so a workflow that runs it on every execution never fills your template limit. The output is the template plus `reused`, `true` when the existing copy was returned and `false` when a new one was created. If you delete the copy, the next run creates a new one with a new id, so map the template id from this node's output into the next node; do not hard-code it.

## Image operations

**Upload** (needs the `images:write` scope) stores an image and returns its details plus `reference`, a `zandovi://images/<id>` value you map into an image variable of Generate or Submit. Choose a Source of Binary File (the "Input Binary Field" of the input item, default `data`) or URL. Options: Name, and Visibility (Private by default, or Shared). The image must be JPEG, PNG, GIF or WebP and at most 5 MB; the node checks both before sending anything. Uploading the same URL twice returns the existing image; `reused` is `true` when the existing image was returned. Uploading a binary file always creates a new image, so upload each file once and reuse its `reference`. A binary without a type, or typed `application/octet-stream`, is typed from its file name extension. Upload is limited to 30 requests a minute; the node waits out short limits and retries.

**Get Many** (needs the `images:read` scope) lists your organisation's images, newest first, one output item per image with its `reference`. Search filters by name; turn on Return All or set a Limit (default 50, up to 500).

## Batch Job operations

**Submit** (needs the `render` and `templates:read` scopes) turns **all** input items into the rows of **one** batch job and outputs **one** item for the whole job, paired to every input item.

- **Template** and **Variables** work as in Generate. The Variables mapper is evaluated once per input item, and each item becomes one row, with the same rules: every value is sent as text, and an empty field is left out so the template default renders. The template, Format and options come from the first item.
- **Format**: PNG (default), JPEG, WebP or PDF.
- **Wait for Completion** (default on) and **Timeout (Minutes)** (default 10, 1 to 60): see below.
- **Options**: **File Name Pattern**, **Output DPI** or **Scale** (not both), **Callback URL** (see [Batch completion with a Wait node](#batch-completion-with-a-wait-node)) and **Idempotency Key**.

**File Name Pattern** names the files inside the result archive with single-brace placeholders: `{variable}` for any variable of the row, such as `{name}`, plus `{index}` (the row number, zero-padded to three digits), `{timestamp}` and `{random}` (six characters). For example `{name}-{index}`. Leave out the extension; Zandovi adds the format's. Substituted values are lowercased, and characters other than `a-z`, `0-9`, `-` and `_` become hyphens. Without a pattern the files are `image-000`, `image-001` and so on.

**Plan row cap.** Before submitting, the node reads your account once and compares the number of input items with your plan's rows per batch job. When there are more, it fails without submitting or charging anything: "<N> items exceed your plan's limit of <M> rows per batch job. Put a Loop Over Items node with batch size <M> before this node." Do exactly that: a **Loop Over Items** node with that batch size in front of Submit sends one job per batch.

**Idempotency.** Submit sends an `Idempotency-Key` of `n8n-` plus the SHA-256 of the workflow ID, execution ID, node name, run index (n8n's `$runIndex` for the node) and `batch`, or the **Idempotency Key** option as it is. When **Retry On Fail** retries a submit, Zandovi returns the job the first attempt created and charges once, except for Submit used as an **AI Agent** tool in older AI Agent versions (2.x), where a retried tool call can get a new run index, so it submits again and is charged for a new job. Each pass of a **Loop Over Items** loop and each **AI Agent** tool call is a new run of the node, so it submits and is charged for a new job. Re-running an execution submits and charges a new job.

**Waiting for the job.** With **Wait for Completion** on, the node checks the job every 5 seconds until it finishes:

- **Completed** (even when some rows failed; check `failedItems`, or list the rows with **Get Items**) and **Cancelled** jobs are output as their final state.
- A **failed** job fails the node with "Batch job <id> failed: <detail>", or produces an error item when **Continue On Fail** is on.
- When **Timeout (Minutes)** passes first, the node fails with "Batch job <id> is still <status> after <T> min. It keeps running; check it later with Batch Job → Get, or use a Callback URL with a Wait node." The job is not cancelled. Stopping the execution while it waits also leaves the job running.

n8n Cloud plans limit how long an execution may run, so a 10-minute wait may not fit your plan. For long jobs, turn **Wait for Completion** off and use the Callback URL with a Wait node instead. With it off, Submit outputs the submitted job (`jobId`, `status`, `totalItems`, …) straight away.

Inside a **Loop Over Items** loop, keep **Wait for Completion** on, so each pass waits for its job to finish before the next pass submits: Zandovi runs at most two batch jobs at once for each user (all of their API keys together), and a third submitted while two are running fails at once with Zandovi's message ("Concurrent batch limit exceeded"), without waiting. A used-up monthly quota fails at once with the quota message.

**Get** outputs a job's status and counts (`status`, `totalItems`, `completedItems`, `failedItems`, …) by **Job ID**.

**Get Items** outputs one item per row of the job: its `rowIndex`, `status`, `error` (for a failed row), `filename` and `size`. **Return All** is on by default; turn it off to return up to **Limit** rows.

**Get Result** returns a finished job's signed download link to its ZIP archive as `{ url, expiresAt }`. **The link expires after about an hour**: call Get Result again for a fresh link rather than storing the URL for later. The node does not download the archive itself, because the archive of a large job can exceed n8n's memory. To fetch it, add an **HTTP Request** node with **Method** GET, **URL** `{{ $json.url }}`, **Authentication** None (the link is already signed, so the Zandovi credential is not needed) and, under Options, **Response** → **Response Format** set to **File**: n8n streams the download into its binary storage. Then unzip it with a **Compression** node (Decompress), or send it on with an upload node such as S3 or Google Drive. The Compression node holds the whole archive and the unzipped files in memory, about twice the archive size, so keep each batch job small enough for your n8n's memory (640 MiB on small n8n Cloud plans), for example with a **Loop Over Items** node before Submit; to handle each image on its own, **Template → Generate** per item avoids the archive altogether. Get Result on a job that is still running fails with "Batch job <id> has not finished yet"; on a job that ended `FAILED` or `CANCELLED` it fails with "Batch job <id> ended <status> and has no result".

**Cancel** stops a running job and refunds the rows it has not rendered. Zandovi answers the cancel with no content, so the node then reads the job and outputs it plus `refundedRows` (the rows a cancelled job did not render; `0` when the job had already finished and the cancel did nothing).

Get, Get Items, Get Result and Cancel need the `render` scope.

## Batch completion with a Wait node

For a job that may take longer than your execution may run, let Zandovi call your workflow back instead of waiting in the node:

1. **Zandovi → Batch Job → Submit** with **Wait for Completion** off and the option **Callback URL** set to `{{ $execution.resumeUrl }}`.
2. A **Wait** node with **Resume** set to **On Webhook Call** and **HTTP Method** set to **POST**. The execution pauses here until the job finishes; Zandovi then POSTs the job ID, its final status and its row counts to the resume URL.
3. An **IF** node whose condition is `{{ $json.body.status }}` equal to `COMPLETED`. A job that ended `FAILED` or `CANCELLED` has no result, so handle it on the false branch.
4. On the true branch, **Zandovi → Batch Job → Get Result** with **Job ID** set to `{{ $json.body.jobId }}`, then download the archive from its `url` with an **HTTP Request** node as described under Get Result.

The callback carries no download link, because a link would expire before a retried delivery arrived; Get Result fetches a fresh one. Zandovi may deliver a callback more than once. A repeat that arrives after the Wait node has resumed finds no waiting execution, n8n answers it, and the workflow does not run twice.

**The Callback URL must be a publicly reachable `https://` address.** Zandovi refuses anything else with a `400`, and the node shows its message. A self-hosted n8n on `http://localhost:5678` therefore cannot use this pattern until n8n's public URL (the `WEBHOOK_URL` setting) is an `https://` address reachable from the internet; use **Wait for Completion** instead.

## Calling other endpoints

For a Zandovi API endpoint the node does not cover, add an **HTTP Request** node, set **Authentication** to **Predefined Credential Type**, choose **Zandovi API**, and select your credential. The key is attached for you, so you do not paste it into the request. Use the full URL, for example `https://app.zandovi.com/api/v1/account`.

## Retries and errors

The node processes input items one at a time, in order: the request for an item starts only after the previous item's request has finished, retries included. Every request times out after 120 seconds, and a timeout fails with "Zandovi did not respond within 120 s".

The node retries on its own in two cases:

- **Rate limit.** When Zandovi answers `429` with `RATE_LIMIT_EXCEEDED` and a `Retry-After` of 30 seconds or less, the node waits that long and sends the same request again, at most 3 times. When the fourth attempt is also rate limited, or when `Retry-After` is above 30 seconds, the item fails with "Zandovi rate limit reached; retry later".
- **A render already in progress.** When Zandovi answers `409` with `IDEMPOTENCY_IN_PROGRESS` (an earlier attempt with the same Idempotency Key is still rendering), the node waits 2 seconds and tries again, at most 5 times, then fails with "A previous attempt of this render is still running".

A used-up monthly quota is never waited on: the item fails at once with "Monthly render quota used up; it resets on <date>. Upgrade at app.zandovi.com/plans."

Stopping the execution ends a retry wait at once, and the node starts no further request, page or item, with **Continue On Fail** on or off.

These retries run inside one attempt of the node. If you also turn on n8n's **Retry On Fail** node setting, both apply: each n8n attempt can make up to 4 requests for a rate-limited item, so up to (3 + 1) × the number of tries in total. A retried render sends the same Idempotency Key, so Zandovi does not charge it twice, except for a Zandovi tool called by an **AI Agent** in older AI Agent versions (2.x), where a retried tool call can get a new run index, so it renders again and is charged again.

Other errors fail the item with a message that says what to fix:

| Zandovi answers | The item fails with |
|---|---|
| `400` | The reason, plus each invalid field or variable |
| `401` | "Invalid or revoked API key. Create one under Settings → API Keys." |
| `402` | The plan limit that was hit |
| `403` with `INSUFFICIENT_SCOPE` | "This API key lacks the `<scope>` scope needed for <operation>; create a key that has it" |
| `404` | "<Template / Batch job / Image> not found, or not visible to this API key's account" |
| `422` with `IDEMPOTENCY_KEY_REUSED` | "This Idempotency Key was already used with different inputs" |
| `3xx` | "Zandovi answered with a redirect, which the node does not follow; check the Base URL of the credential" |
| `5xx` | "Zandovi service error (<status>); retry later" |

With **Continue On Fail** on, a failing item produces an output item `{ "error": "<message>", "status": <HTTP status>, "code": "<Zandovi error code>" }` paired to its input, and the node goes on with the next item. With it off, the node stops at the first failing item and reports that item's index. Your API key never appears in output data or error messages: a network failure is reported by its error code only, and the key is redacted from any message Zandovi sends back.

## Example workflows

Import any of these into n8n (Workflows → Import from File). They ship without credentials: connect your own after importing, and read the sticky notes on each for the API key scopes and the starter template it needs.

- [`examples/og-image-per-blog-post.json`](examples/og-image-per-blog-post.json): an RSS Feed Trigger renders an OG image for every new blog post as a share link (uses the `open-graph-starter-variables` starter).
- [`examples/coupon-per-new-customer.json`](examples/coupon-per-new-customer.json): a Stripe Trigger renders a coupon with a QR code for every new customer and emails it with Gmail (uses `coupon-starter-variables`).
- [`examples/certificate-pdf-from-sheets.json`](examples/certificate-pdf-from-sheets.json): a Google Sheets Trigger renders a PDF certificate for every new row, then emails it and saves it to Google Drive (uses `certificate-starter-variables`).

The n8n.io template links are added after the node is verified by n8n.

## Compatibility

The node is built against `n8n-workflow` 2.16 and needs n8n 2.16 or later. It has no runtime dependencies.

## License

[MIT](LICENSE)
