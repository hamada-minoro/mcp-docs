import { prisma } from "../db/client.js";
import { generateApiKey, ADMIN_SCOPES, COLLABORATOR_SCOPES, READONLY_SCOPES } from "../utils/apiKey.js";
import { auditLog } from "../utils/audit.js";

const SCOPES_BY_ROLE = {
  admin: ADMIN_SCOPES,
  collaborator: COLLABORATOR_SCOPES,
  readonly: READONLY_SCOPES,
} as const;

export type UserRole = keyof typeof SCOPES_BY_ROLE;

export interface CreateUserInput {
  name: string;
  email: string;
  role: UserRole;
  allowedProjects?: string[];
  expiresAt?: string;
  createdByUserId: string;
  createdByApiKeyId: string;
}

export interface CreateUserResult {
  user_id: string;
  name: string;
  email: string;
  role: string;
  api_key: string;
  key_prefix: string;
  scopes: string[];
  allowed_projects: string[];
  expires_at: string | null;
  warning: string;
}

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const { name, email, role, allowedProjects = [], expiresAt, createdByUserId, createdByApiKeyId } = input;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(`Já existe um usuário com o e-mail '${email}'.`);
  }

  const user = await prisma.user.create({
    data: { name, email, role, active: true },
  });

  const generated = generateApiKey("live");
  const scopes = SCOPES_BY_ROLE[role];
  const parsedExpiry = expiresAt ? new Date(expiresAt) : null;

  const apiKey = await prisma.apiKey.create({
    data: {
      userId: user.id,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      scopes: [...scopes],
      allowedProjects,
      status: "active",
      expiresAt: parsedExpiry,
    },
  });

  await auditLog({
    userId: createdByUserId,
    apiKeyId: createdByApiKeyId,
    action: "admin.user.created",
    targetType: "user",
    targetId: user.id,
    metadata: { email, role, scopes, allowedProjects, keyPrefix: generated.prefix },
    result: "success",
  });

  return {
    user_id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    api_key: generated.raw,
    key_prefix: generated.prefix,
    scopes: [...scopes],
    allowed_projects: allowedProjects,
    expires_at: parsedExpiry?.toISOString() ?? null,
    warning: "Guarde esta API key agora — ela não poderá ser recuperada depois.",
  };
}
