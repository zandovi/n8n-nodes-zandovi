import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export const INVALID_API_KEY_MESSAGE =
	'Invalid or revoked API key. Create one under Settings → API Keys.';

export class ZandoviApi implements ICredentialType {
	name = 'zandoviApi';

	displayName = 'Zandovi API';

	icon: Icon = { light: 'file:zandovi.svg', dark: 'file:zandovi.dark.svg' };

	documentationUrl = 'https://docs.zandovi.com/integrations/n8n/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'The Zandovi API key, created under Settings → API Keys, that every request from this credential sends',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.zandovi.com',
			description:
				'The address of the Zandovi app the requests go to, where a trailing /api/v1 is ignored; keep the default unless Zandovi support gave you another',
		},
	];

	// Only X-Api-Key: the API refuses a request that also carries an Authorization header.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Api-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{($credentials.baseUrl || "https://app.zandovi.com").replace(/\\/+$/, "").replace(/\\/api\\/v1$/i, "").replace(/\\/+$/, "")}}',
			url: '/api/v1/account',
			method: 'GET',
			// A redirect would carry X-Api-Key to its target; the API never redirects.
			disableFollowRedirect: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: { value: 401, message: INVALID_API_KEY_MESSAGE },
			},
		],
	};
}
