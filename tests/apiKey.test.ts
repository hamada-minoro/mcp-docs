import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  hasScope,
  ADMIN_SCOPES,
  COLLABORATOR_SCOPES,
  READONLY_SCOPES,
} from "../src/utils/apiKey.js";

describe("generateApiKey", () => {
  it("deve gerar chave no formato correto (live)", () => {
    const { raw, prefix, hash } = generateApiKey("live");
    expect(raw).toMatch(/^docsk_live_[a-f0-9]{4}_[a-f0-9]{64}$/);
    expect(prefix).toMatch(/^docsk_live_[a-f0-9]{4}_$/);
    expect(hash).toHaveLength(64);
  });

  it("deve gerar chave no formato correto (dev)", () => {
    const { raw } = generateApiKey("dev");
    expect(raw).toMatch(/^docsk_dev_[a-f0-9]{4}_[a-f0-9]{64}$/);
  });

  it("deve gerar chaves únicas a cada chamada", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.raw).not.toBe(key2.raw);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it("o hash deve ser determinístico", () => {
    const { raw, hash } = generateApiKey();
    expect(hashApiKey(raw)).toBe(hash);
  });
});

describe("hasScope", () => {
  it("deve retornar true para escopo presente", () => {
    expect(hasScope(["docs:search", "docs:read"], "docs:search")).toBe(true);
  });

  it("deve retornar false para escopo ausente", () => {
    expect(hasScope(["docs:search"], "docs:upload")).toBe(false);
  });

  it("admin tem todos os escopos", () => {
    const adminHasAll = ADMIN_SCOPES.every((s) => ADMIN_SCOPES.includes(s));
    expect(adminHasAll).toBe(true);
  });

  it("colaborador tem escopos básicos", () => {
    expect(COLLABORATOR_SCOPES).toContain("docs:search");
    expect(COLLABORATOR_SCOPES).toContain("docs:upload");
    expect(COLLABORATOR_SCOPES).not.toContain("admin:keys");
  });

  it("readonly não tem upload", () => {
    expect(READONLY_SCOPES).not.toContain("docs:upload");
    expect(READONLY_SCOPES).not.toContain("docs:delete");
  });
});
