import { HTTPError } from './protocol';

export type ResourceKind = 'chat' | 'wiki';
export type Policy = { idle_seconds: number | null; age_seconds: number | null; archive_on_ttl: boolean; paused: boolean };
export type Receipt = { id: string; key: string; sha256: string; created_at: number; objects: number; bytes: number };
export type ResourceRecord = {
  id: string; kind: ResourceKind; created_at: number; last_activity_at: number; policy: Policy;
  policy_version: number; version: number; state: 'active' | 'archiving' | 'expiring' | 'deleting' | 'deleted' | 'restoring';
  updated_at: number; latest_archive: Receipt | null; reason: string | null; error: string | null;
  attempts: number; retry_at: number | null; deleted_at: number | null;
};
export interface ManagementSettings {
  MANAGEMENT_ENABLED?: string;
  MANAGEMENT_CHAT_IDLE_SECONDS?: string; MANAGEMENT_CHAT_AGE_SECONDS?: string;
  MANAGEMENT_WIKI_IDLE_SECONDS?: string; MANAGEMENT_WIKI_AGE_SECONDS?: string;
  MANAGEMENT_ARCHIVE_ON_TTL?: string;
  MANAGEMENT_AUDIT_DAYS?: string;
  RETENTION_SECONDS?: string;
}
export function seconds(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 315360000) throw new HTTPError(400, 'TTL must be null or a whole number of seconds from 1 to 315360000');
  return value;
}
export function policyInput(value: Record<string, unknown>): Policy {
  if (Object.keys(value).some(k => !['idle_seconds','age_seconds','archive_on_ttl','paused'].includes(k)) || typeof value.archive_on_ttl !== 'boolean' || typeof value.paused !== 'boolean') throw new HTTPError(400, 'Provide both TTLs, archive_on_ttl, and paused');
  return { idle_seconds: seconds(value.idle_seconds), age_seconds: seconds(value.age_seconds), archive_on_ttl: value.archive_on_ttl, paused: value.paused };
}
export function defaults(env: ManagementSettings, kind: ResourceKind): Policy {
  const read = (raw: string | undefined, fallback: string) => {
    const value = raw ?? fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HTTPError(503, 'Invalid management TTL configuration');
    try { return value === '0' ? null : seconds(Number(value)); } catch { throw new HTTPError(503, 'Invalid management TTL configuration'); }
  };
  if (env.MANAGEMENT_ARCHIVE_ON_TTL !== undefined && !['0','1'].includes(env.MANAGEMENT_ARCHIVE_ON_TTL)) throw new HTTPError(503, 'Invalid archive default');
  return { idle_seconds: read(kind === 'chat' ? env.MANAGEMENT_CHAT_IDLE_SECONDS : env.MANAGEMENT_WIKI_IDLE_SECONDS, kind === 'chat' ? env.RETENTION_SECONDS ?? '86400' : '0'),
    age_seconds: read(kind === 'chat' ? env.MANAGEMENT_CHAT_AGE_SECONDS : env.MANAGEMENT_WIKI_AGE_SECONDS, '0'), archive_on_ttl: env.MANAGEMENT_ARCHIVE_ON_TTL === '1', paused: false };
}
export function deadlines(record: Pick<ResourceRecord, 'created_at' | 'last_activity_at' | 'policy'>) {
  const p = record.policy;
  const idle = p.idle_seconds === null ? null : record.last_activity_at + p.idle_seconds * 1000;
  const age = p.age_seconds === null ? null : record.created_at + p.age_seconds * 1000;
  return { idle_at: idle, age_at: age, expires_at: p.paused ? null : idle === null ? age : age === null ? idle : Math.min(idle, age) };
}
export function auditDays(env: ManagementSettings) {
  const days = Number(env.MANAGEMENT_AUDIT_DAYS ?? '90');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HTTPError(503, 'Invalid audit retention');
  return days;
}
