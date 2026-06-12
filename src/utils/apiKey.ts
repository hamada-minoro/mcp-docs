import { createHash, randomBytes } from "crypto";

export interface GeneratedApiKey {
  raw: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(env: "dev" | "live" = "live"): GeneratedApiKey {
  const identifier = randomBytes(4).toString("hex").slice(0, 4);
  const secret = randomBytes(32).toString("hex");
  const raw = `docsk_${env}_${identifier}_${secret}`;
  const prefix = `docsk_${env}_${identifier}_`;
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export const ALL_SCOPES = [
  "docs:search",
  "docs:read",
  "docs:download",
  "docs:upload",
  "docs:update",
  "docs:delete",
  "admin:keys",
  "admin:audit",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const COLLABORATOR_SCOPES: Scope[] = [
  "docs:search",
  "docs:read",
  "docs:download",
  "docs:upload",
];

export const READONLY_SCOPES: Scope[] = [
  "docs:search",
  "docs:read",
  "docs:download",
];

export const ADMIN_SCOPES: Scope[] = [...ALL_SCOPES];

export function hasScope(keyScopes: string[], required: Scope): boolean {
  return keyScopes.includes(required);
}
