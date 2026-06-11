// Background job runner. Port of backend/app/jobs.py.
// Jobs are tracked in the repository (S3 or local FS) so status survives restart.
// Execution is fire-and-forget via setImmediate so the API call returns instantly.

import { randomUUID } from 'node:crypto';
import { getRepository } from './persistence/index.js';
import { getLogger } from './logger.js';

const log = getLogger('jobs');

export const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

export async function createJob(kind, params) {
  const jobId = randomUUID();
  const repo = await getRepository();
  await repo.putJob(jobId, {
    kind,
    status: JobStatus.QUEUED,
    params,
    progress: 'Job created',
  });
  return jobId;
}

export async function markRunning(jobId, progress = 'Started') {
  const repo = await getRepository();
  await repo.updateJob(jobId, { status: JobStatus.RUNNING, progress });
}

export async function updateProgress(jobId, progress) {
  const repo = await getRepository();
  await repo.updateJob(jobId, { progress });
}

export async function markSucceeded(jobId, result) {
  const repo = await getRepository();
  await repo.updateJob(jobId, {
    status: JobStatus.SUCCEEDED,
    result: typeof result === 'object' && result !== null ? result : { value: result },
    progress: 'Completed',
    completed_at: new Date().toISOString(),
  });
}

export async function markFailed(jobId, error) {
  const repo = await getRepository();
  await repo.updateJob(jobId, {
    status: JobStatus.FAILED,
    error: String(error).slice(0, 2000),
    progress: 'Failed',
    completed_at: new Date().toISOString(),
  });
}

/**
 * Fire-and-forget runner. Caller already returned job_id to the client.
 * `task` is an async function that returns a result object.
 */
export function schedule(jobId, task) {
  setImmediate(async () => {
    try {
      await markRunning(jobId);
      const result = await task();
      await markSucceeded(jobId, result);
      log.info({ job_id: jobId }, 'job_succeeded');
    } catch (err) {
      log.error({ job_id: jobId, error: String(err), stack: err.stack }, 'job_failed');
      await markFailed(jobId, `${err.name || 'Error'}: ${err.message || err}`);
    }
  });
}
