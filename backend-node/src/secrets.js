// Resolve GitHub PAT for private-repo clones.
// Port of backend/app/secrets.py.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { settings } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('secrets');
let _client = null;

function client() {
  if (!_client) _client = new SecretsManagerClient({ region: settings.awsRegion });
  return _client;
}

async function fetchFromSecretsManager(arn) {
  try {
    const resp = await client().send(new GetSecretValueCommand({ SecretId: arn }));
    const raw = resp.SecretString;
    if (!raw) return null;
    // Try JSON object case
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of ['token', 'github_token', 'value']) {
          if (k in obj) return String(obj[k]);
        }
        for (const v of Object.values(obj)) {
          if (typeof v === 'string') return v;
        }
      }
    } catch {
      // not JSON — fall through to raw string
    }
    return raw;
  } catch (err) {
    log.error({ arn, error: String(err) }, 'secret_fetch_failed');
    return null;
  }
}

export async function getGithubToken() {
  if (settings.githubTokenSecretArn) {
    return fetchFromSecretsManager(settings.githubTokenSecretArn);
  }
  if (settings.githubTokenEnv) {
    return settings.githubTokenEnv.trim() || null;
  }
  return null;
}
