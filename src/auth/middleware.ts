import { Request, Response, NextFunction } from "express";
import { prisma } from "../db/client.js";
import { hashApiKey } from "../utils/apiKey.js";
import { auditLog } from "../utils/audit.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: {
        id: string;
        name: string;
        email: string;
        role: string;
      };
      authApiKey?: {
        id: string;
        scopes: string[];
        allowedProjects: string[];
      };
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "API key ausente. Envie no header: Authorization: Bearer <sua-chave>" });
    return;
  }

  const rawKey = authHeader.slice(7).trim();

  if (!rawKey.startsWith("docsk_")) {
    res.status(401).json({ error: "Formato de API key inválido." });
    return;
  }

  const keyHash = hashApiKey(rawKey);

  const apiKey = await prisma.apiKey.findFirst({
    where: { keyHash },
    include: { user: true },
  });

  if (!apiKey || !apiKey.user.active) {
    res.status(401).json({ error: "API key inválida ou usuário inativo." });
    return;
  }

  if (apiKey.status === "revoked") {
    res.status(401).json({ error: "API key revogada." });
    return;
  }

  if (apiKey.status === "expired" || (apiKey.expiresAt && apiKey.expiresAt < new Date())) {
    res.status(401).json({ error: "API key expirada." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";

  prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: {
        lastUsedAt: new Date(),
        ipAddresses: {
          set: [...new Set([...(apiKey.ipAddresses ?? []), ip])].slice(-10),
        },
      },
    })
    .catch(() => {});

  req.authUser = {
    id: apiKey.user.id,
    name: apiKey.user.name,
    email: apiKey.user.email,
    role: apiKey.user.role,
  };

  req.authApiKey = {
    id: apiKey.id,
    scopes: apiKey.scopes,
    allowedProjects: apiKey.allowedProjects,
  };

  next();
}

export function requireScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.authApiKey?.scopes.includes(scope)) {
      await auditLog({
        userId: req.authUser?.id,
        apiKeyId: req.authApiKey?.id,
        action: "auth.scope_denied",
        metadata: { required_scope: scope, available_scopes: req.authApiKey?.scopes },
        ipAddress: req.socket.remoteAddress,
        userAgent: req.headers["user-agent"],
        result: "error",
        errorMsg: `Escopo ${scope} não autorizado`,
      });

      res.status(403).json({
        error: `Permissão insuficiente. Escopo necessário: ${scope}`,
      });
      return;
    }
    next();
  };
}
