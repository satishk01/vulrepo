// Repository factory — dispatches to LocalRepository or S3Repository based on STORAGE_BACKEND.

import { settings } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('repo');

let _repo = null;

export async function getRepository() {
  if (_repo) return _repo;
  const backend = settings.storageBackend;
  if (backend === 'local') {
    const { LocalRepository } = await import('./localRepository.js');
    _repo = new LocalRepository();
    log.info({ backend: 'local' }, 'repository_selected');
  } else {
    const { S3Repository } = await import('./s3Repository.js');
    _repo = new S3Repository();
    log.info({ backend: 's3' }, 'repository_selected');
  }
  return _repo;
}
