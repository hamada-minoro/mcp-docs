import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";

export interface AuditEntry {
  userId?: string;
  apiKeyId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  result?: string;
  errorMsg?: string;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        apiKeyId: entry.apiKeyId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ? (entry.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        result: entry.result ?? "success",
        errorMsg: entry.errorMsg ?? null,
      },
    });
  } catch {
    // audit failures should never crash the request
    console.error("[audit] Falha ao registrar log de auditoria");
  }
}
