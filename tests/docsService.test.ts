import { describe, it, expect, vi, beforeEach } from "vitest";
import { suggestDocTemplate } from "../src/docs/service.js";
import { validateMarkdown } from "../src/utils/markdownValidator.js";

vi.mock("../src/db/client.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    documentChunk: {
      createMany: vi.fn(),
    },
  },
}));

vi.mock("../src/storage/minio.js", () => ({
  uploadMarkdown: vi.fn().mockResolvedValue(undefined),
  getMarkdownContent: vi.fn().mockResolvedValue("# Conteúdo mock"),
  getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://minio.local/presigned-url"),
  buildS3Key: vi.fn((project: string, category: string, id: string, file: string, mod?: string) =>
    `docs/${project}/${category}${mod ? "/" + mod : ""}/${id}/${file}`
  ),
  buildRejectedS3Key: vi.fn((userId: string, file: string) => `rejected/${userId}/${file}`),
}));

import { prisma } from "../src/db/client.js";
import { searchDocs, getDoc, generateDownloadUrl, uploadDoc, listRecentDocs } from "../src/docs/service.js";

const mockDoc = {
  id: "doc-001",
  title: "Correção de download no SafeDocs Admin",
  filename: "correcao-download.md",
  project: "SafeDocs",
  module: "Admin",
  category: "Bug",
  status: "active",
  tags: ["download", "storage"],
  s3Key: "docs/safedocs/doc-001/correcao-download.md",
  createdBy: "user-001",
  updatedBy: null,
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-10"),
};

describe("searchDocs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deve retornar resultados formatados corretamente", async () => {
    vi.mocked(prisma.document.findMany).mockResolvedValue([mockDoc] as any);

    const result = await searchDocs({
      query: "download",
      allowedProjects: ["SafeDocs"],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].doc_id).toBe("doc-001");
    expect(result.results[0].title).toBe("Correção de download no SafeDocs Admin");
    expect(result.results[0].tags).toContain("download");
  });

  it("deve retornar lista vazia quando não há resultados", async () => {
    vi.mocked(prisma.document.findMany).mockResolvedValue([]);
    const result = await searchDocs({ query: "inexistente", allowedProjects: [] });
    expect(result.results).toHaveLength(0);
  });
});

describe("getDoc", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deve retornar documento com conteúdo markdown", async () => {
    vi.mocked(prisma.document.findFirst).mockResolvedValue(mockDoc as any);

    const result = await getDoc("doc-001", ["SafeDocs"]);

    expect(result.doc_id).toBe("doc-001");
    expect(result.title).toBe("Correção de download no SafeDocs Admin");
    expect(result.content_markdown).toBe("# Conteúdo mock");
    expect(result.metadata.project).toBe("SafeDocs");
  });

  it("deve lançar erro quando documento não encontrado", async () => {
    vi.mocked(prisma.document.findFirst).mockResolvedValue(null);
    await expect(getDoc("inexistente", ["SafeDocs"])).rejects.toThrow("não encontrado");
  });
});

describe("generateDownloadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deve gerar URL de download com metadados", async () => {
    vi.mocked(prisma.document.findFirst).mockResolvedValue(mockDoc as any);

    const result = await generateDownloadUrl("doc-001", ["SafeDocs"]);

    expect(result.download_url).toContain("presigned-url");
    expect(result.expires_in_seconds).toBe(300);
    expect(result.filename).toBe("correcao-download.md");
  });
});

describe("uploadDoc", () => {
  beforeEach(() => vi.clearAllMocks());

  const VALID_CONTENT = `# Bug: Teste de Upload

## Metadados

- **Categoria:** Bug
- **Projeto:** SafeDocs
- **Módulo:** Admin
- **Autor:** Automático pela API key
- **Data de criação:** 12/06/2026
- **Última atualização:** 12/06/2026
- **Status:** Ativo
- **Tags:** teste

---

## 1. Contexto

Contexto de teste.

## 2. Problema ou dor identificada

Problema de teste.

## 3. Impacto

Impacto de teste.

## 4. Causa raiz

Causa raiz de teste.

## 5. Solução aplicada

Solução de teste.

## 6. Arquivos, rotas ou serviços envolvidos

- test.ts

## 7. Passo a passo

1. Executar teste.

## 8. Como testar

1. Verificar resultado.

## 9. Riscos ou pontos de atenção

Nenhum.

## 10. Documentações relacionadas

N/A

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| 12/06/2026 | Dev | Criação |
`;

  it("deve fazer upload de documento válido com sucesso", async () => {
    vi.mocked(prisma.document.create).mockResolvedValue({
      ...mockDoc,
      id: "new-doc-001",
      status: "active",
    } as any);
    vi.mocked(prisma.documentChunk.createMany).mockResolvedValue({ count: 3 } as any);

    const result = await uploadDoc({
      filename: "bug-teste.md",
      content_markdown: VALID_CONTENT,
      project: "SafeDocs",
      category: "Bug",
      userId: "user-001",
      allowedProjects: ["SafeDocs"],
    });

    expect(result.status).toBe("active");
    expect(result.doc_id).toBeDefined();
    expect(result.indexing_status).toBe("completed");
  });

  it("deve rejeitar upload para projeto não autorizado", async () => {
    await expect(
      uploadDoc({
        filename: "bug-teste.md",
        content_markdown: VALID_CONTENT,
        project: "ProjetoProibido",
        category: "Bug",
        userId: "user-001",
        allowedProjects: ["SafeDocs"],
      })
    ).rejects.toThrow("Sem permissão");
  });
});

describe("listRecentDocs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deve listar documentos recentes", async () => {
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      {
        id: "doc-001",
        title: "Doc 1",
        filename: "doc1.md",
        project: "SafeDocs",
        module: "Admin",
        category: "Bug",
        updatedAt: new Date(),
      },
    ] as any);

    const result = await listRecentDocs(undefined, undefined, 10, ["SafeDocs"]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].doc_id).toBe("doc-001");
  });
});

describe("suggestDocTemplate", () => {
  it("deve gerar template completo para Bug", () => {
    const result = suggestDocTemplate({
      category: "Bug",
      project: "SafeDocs",
      module: "Admin",
      problem: "erro ao gerar URL assinada",
    });

    expect(result.filename_suggestion).toContain(".md");
    expect(result.content_markdown).toContain("# Bug:");
    expect(result.content_markdown).toContain("## Metadados");
    expect(result.content_markdown).toContain("SafeDocs");
    expect(result.content_markdown).toContain("Admin");
  });

  it("deve sanitizar o nome do arquivo", () => {
    const result = suggestDocTemplate({
      category: "Procedimento",
      project: "Reg+",
      problem: "Deploy para produção com caracteres $peciais!",
    });

    expect(result.filename_suggestion).toMatch(/^[a-z0-9-]+\.md$/);
  });
});
