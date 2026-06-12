import { describe, it, expect } from "vitest";
import {
  validateMarkdown,
  extractTitle,
  extractMetadata,
} from "../src/utils/markdownValidator.js";

const VALID_DOC = `# Bug: Falha no download do SafeDocs Admin

## Metadados

- **Categoria:** Bug
- **Projeto:** SafeDocs
- **Módulo:** Admin
- **Autor:** Automático pela API key
- **Data de criação:** 12/06/2026
- **Última atualização:** 12/06/2026
- **Status:** Ativo
- **Tags:** download, storage, url-assinada

---

## 1. Contexto

O erro ocorria durante o processo de download de documentos.

## 2. Problema ou dor identificada

A URL assinada expirava antes do redirect ser processado.

## 3. Impacto

Todos os usuários do módulo Admin eram afetados.

## 4. Causa raiz

Tempo de expiração definido como 30 segundos.

## 5. Solução aplicada

Aumentado para 300 segundos.

## 6. Arquivos, rotas ou serviços envolvidos

- documents.service.ts

## 7. Passo a passo

1. Alterar tempo de expiração.

## 8. Como testar

1. Tentar baixar documento.

## 9. Riscos ou pontos de atenção

Nenhum.

## 10. Documentações relacionadas

N/A

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| 12/06/2026 | Dev | Criação |
`;

describe("validateMarkdown", () => {
  it("deve aceitar documento válido", () => {
    const result = validateMarkdown("bug-download-safedocs.md", VALID_DOC);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("deve rejeitar extensão inválida", () => {
    const result = validateMarkdown("doc.txt", VALID_DOC);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("O arquivo deve ter extensão .md");
  });

  it("deve rejeitar documento sem título principal", () => {
    const result = validateMarkdown("test.md", "Sem título aqui\n\n## Metadados\n");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("título principal"))).toBe(true);
  });

  it("deve rejeitar documento sem seção de Metadados", () => {
    const result = validateMarkdown("test.md", "# Título\n\nConteúdo sem metadados.");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("## Metadados"))).toBe(true);
  });

  it("deve detectar possíveis AWS secrets", () => {
    const docWithSecret = VALID_DOC + "\n\nConfig: AKIAIOSFODNN7EXAMPLE";
    const result = validateMarkdown("test.md", docWithSecret);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("secret") || e.includes("credencial"))).toBe(true);
  });

  it("deve detectar scripts maliciosos", () => {
    const docWithScript = VALID_DOC + "\n\n<script>alert('xss')</script>";
    const result = validateMarkdown("test.md", docWithScript);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("HTML"))).toBe(true);
  });

  it("deve rejeitar arquivo acima de 1MB", () => {
    const bigContent = VALID_DOC + "x".repeat(1024 * 1024 + 1);
    const result = validateMarkdown("test.md", bigContent);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("1 MB"))).toBe(true);
  });

  it("deve gerar avisos para seções recomendadas ausentes", () => {
    const minimal = "# Título\n\n## Metadados\n\n- **Categoria:** Bug\n";
    const result = validateMarkdown("test.md", minimal);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("extractTitle", () => {
  it("deve extrair título correto", () => {
    const title = extractTitle("# Meu Título Aqui\n\nConteúdo.");
    expect(title).toBe("Meu Título Aqui");
  });

  it("deve retornar 'Sem título' quando não há título", () => {
    const title = extractTitle("Conteúdo sem título.");
    expect(title).toBe("Sem título");
  });
});

describe("extractMetadata", () => {
  it("deve extrair metadados do documento", () => {
    const meta = extractMetadata(VALID_DOC);
    expect(meta.category).toBe("Bug");
    expect(meta.project).toBe("SafeDocs");
    expect(meta.module).toBe("Admin");
    expect(meta.status).toBe("Ativo");
    expect(meta.tags).toContain("download");
    expect(meta.tags).toContain("storage");
  });

  it("deve retornar undefined quando campos ausentes", () => {
    const meta = extractMetadata("# Título sem metadados");
    expect(meta.category).toBeUndefined();
    expect(meta.project).toBeUndefined();
  });
});
