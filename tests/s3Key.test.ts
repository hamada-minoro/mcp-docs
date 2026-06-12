import { describe, it, expect } from "vitest";
import { buildS3Key, buildRejectedS3Key } from "../src/storage/minio.js";

describe("buildS3Key", () => {
  it("deve gerar caminho com projeto, categoria e docId", () => {
    const key = buildS3Key("SafeDocs", "Bug", "abc-123", "correcao.md");
    expect(key).toBe("docs/safedocs/bug/abc-123/correcao.md");
  });

  it("deve incluir módulo quando fornecido", () => {
    const key = buildS3Key("SafeDocs", "Bug", "abc-123", "correcao.md", "Admin");
    expect(key).toBe("docs/safedocs/bug/admin/abc-123/correcao.md");
  });

  it("deve slugificar categoria com acento", () => {
    const key = buildS3Key("SafeDocs", "Refatoração", "abc-123", "refactor.md", "Core");
    expect(key).toBe("docs/safedocs/refatoracao/core/abc-123/refactor.md");
  });

  it("deve slugificar 'Decisão técnica'", () => {
    const key = buildS3Key("Reg+", "Decisão técnica", "xyz-789", "decisao.md");
    expect(key).toBe("docs/reg/decisao-tecnica/xyz-789/decisao.md");
  });

  it("deve slugificar projeto com caracteres especiais", () => {
    const key = buildS3Key("Reg+", "Operacional", "id-001", "proc.md");
    expect(key).toBe("docs/reg/operacional/id-001/proc.md");
  });

  it("deve slugificar projeto com espaços", () => {
    const key = buildS3Key("Safe Docs", "Bug", "id-001", "bug.md", "API Layer");
    expect(key).toBe("docs/safe-docs/bug/api-layer/id-001/bug.md");
  });

  it("deve slugificar módulo com acento", () => {
    const key = buildS3Key("SafeDocs", "Procedimento", "id-001", "proc.md", "Autenticação");
    expect(key).toBe("docs/safedocs/procedimento/autenticacao/id-001/proc.md");
  });

  it("caminho sem módulo não deve ter segmento extra", () => {
    const key = buildS3Key("SafeDocs", "Bug", "id-001", "bug.md");
    // docs/safedocs/bug/id-001/bug.md → 5 segmentos
    expect(key.split("/")).toHaveLength(5);
  });

  it("caminho com módulo deve ter um segmento a mais", () => {
    const withoutModule = buildS3Key("SafeDocs", "Bug", "id-001", "bug.md");
    const withModule = buildS3Key("SafeDocs", "Bug", "id-001", "bug.md", "Admin");
    expect(withModule.split("/")).toHaveLength(withoutModule.split("/").length + 1);
  });
});

describe("buildRejectedS3Key", () => {
  it("deve gerar caminho no prefixo rejected com userId", () => {
    const key = buildRejectedS3Key("user-123", "invalid.md");
    expect(key).toMatch(/^rejected\/user-123\/\d+-invalid\.md$/);
  });
});
