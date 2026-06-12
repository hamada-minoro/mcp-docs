import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { authMiddleware } from "../src/auth/middleware.js";
import { hashApiKey } from "../src/utils/apiKey.js";

vi.mock("../src/db/client.js", () => ({
  prisma: {
    apiKey: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/utils/audit.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../src/db/client.js";

const mockApiKey = {
  id: "key-123",
  status: "active",
  expiresAt: null,
  ipAddresses: [],
  scopes: ["docs:search", "docs:read"],
  allowedProjects: ["SafeDocs"],
  user: {
    id: "user-123",
    name: "Test User",
    email: "test@example.com",
    role: "collaborator",
    active: true,
  },
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.get("/test", (req, res) => {
    res.json({ user: req.authUser, apiKey: req.authApiKey });
  });
  return app;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deve rejeitar request sem Authorization header", async () => {
    const app = createApp();
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("API key ausente");
  });

  it("deve rejeitar header sem prefixo Bearer", async () => {
    const app = createApp();
    const res = await request(app).get("/test").set("Authorization", "docsk_live_ab12_secret");
    expect(res.status).toBe(401);
  });

  it("deve rejeitar chave com formato inválido", async () => {
    const app = createApp();
    const res = await request(app).get("/test").set("Authorization", "Bearer invalid_key");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Formato de API key inválido");
  });

  it("deve rejeitar chave não encontrada no banco", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
    const app = createApp();
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer docsk_dev_ab12_" + "a".repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("inválida");
  });

  it("deve rejeitar chave revogada", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({
      ...mockApiKey,
      status: "revoked",
    } as any);
    const app = createApp();
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer docsk_dev_ab12_" + "a".repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("revogada");
  });

  it("deve rejeitar chave expirada", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({
      ...mockApiKey,
      expiresAt: new Date("2020-01-01"),
    } as any);
    const app = createApp();
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer docsk_dev_ab12_" + "a".repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("expirada");
  });

  it("deve aceitar chave válida e injetar dados na request", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as any);
    const app = createApp();
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer docsk_dev_ab12_" + "a".repeat(64));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("user-123");
    expect(res.body.user.email).toBe("test@example.com");
    expect(res.body.apiKey.scopes).toContain("docs:search");
    expect(res.body.apiKey.allowedProjects).toContain("SafeDocs");
  });

  it("deve atualizar lastUsedAt assincronamente", async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(mockApiKey as any);
    const updateSpy = vi.mocked(prisma.apiKey.update);
    const app = createApp();
    await request(app)
      .get("/test")
      .set("Authorization", "Bearer docsk_dev_ab12_" + "a".repeat(64));

    await new Promise((r) => setTimeout(r, 10));
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-123" },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    );
  });
});
