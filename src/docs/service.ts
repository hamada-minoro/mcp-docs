import { prisma } from "../db/client.js";
import {
  uploadMarkdown,
  getMarkdownContent,
  getPresignedDownloadUrl,
  buildS3Key,
} from "../storage/minio.js";
import {
  validateMarkdown,
  extractTitle,
  extractMetadata,
} from "../utils/markdownValidator.js";

export interface SearchDocsInput {
  query: string;
  project?: string;
  module?: string;
  category?: string;
  limit?: number;
  allowedProjects: string[];
}

export interface SearchDocResult {
  doc_id: string;
  title: string;
  filename: string;
  project: string;
  module: string | null;
  category: string;
  status: string;
  tags: string[];
  summary: string;
  score: number;
  updated_at: string;
}

export async function searchDocs(input: SearchDocsInput): Promise<{ results: SearchDocResult[] }> {
  const { query, project, module, category, limit = 5, allowedProjects } = input;

  const whereClause: Record<string, unknown> = {
    status: "active",
  };

  if (allowedProjects.length > 0) {
    whereClause.project = { in: allowedProjects };
  }

  if (project) {
    whereClause.project = { contains: project, mode: "insensitive" };
  }

  if (module) {
    whereClause.module = { contains: module, mode: "insensitive" };
  }

  if (category) {
    whereClause.category = { contains: category, mode: "insensitive" };
  }

  const docs = await prisma.document.findMany({
    where: {
      ...whereClause,
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { filename: { contains: query, mode: "insensitive" } },
        { tags: { hasSome: [query.toLowerCase()] } },
        { module: { contains: query, mode: "insensitive" } },
      ],
    },
    take: Math.min(limit, 20),
    orderBy: { updatedAt: "desc" },
  });

  return {
    results: docs.map((doc) => ({
      doc_id: doc.id,
      title: doc.title,
      filename: doc.filename,
      project: doc.project,
      module: doc.module,
      category: doc.category,
      status: doc.status,
      tags: doc.tags,
      summary: `Documento ${doc.category} do projeto ${doc.project}${doc.module ? ` / ${doc.module}` : ""}`,
      score: 1.0,
      updated_at: doc.updatedAt.toISOString(),
    })),
  };
}

export async function getDoc(docId: string, allowedProjects: string[]): Promise<{
  doc_id: string;
  title: string;
  filename: string;
  content_markdown: string;
  metadata: {
    project: string;
    module: string | null;
    category: string;
    status: string;
    tags: string[];
    created_at: string;
    updated_at: string;
  };
}> {
  const doc = await prisma.document.findFirst({
    where: {
      id: docId,
      ...(allowedProjects.length > 0 ? { project: { in: allowedProjects } } : {}),
    },
  });

  if (!doc) throw new Error(`Documento '${docId}' não encontrado ou sem permissão de acesso.`);

  const content = await getMarkdownContent(doc.s3Key);

  return {
    doc_id: doc.id,
    title: doc.title,
    filename: doc.filename,
    content_markdown: content,
    metadata: {
      project: doc.project,
      module: doc.module,
      category: doc.category,
      status: doc.status,
      tags: doc.tags,
      created_at: doc.createdAt.toISOString(),
      updated_at: doc.updatedAt.toISOString(),
    },
  };
}

export async function generateDownloadUrl(
  docId: string,
  allowedProjects: string[],
  expiresInSeconds = 300
): Promise<{ download_url: string; expires_in_seconds: number; filename: string }> {
  const doc = await prisma.document.findFirst({
    where: {
      id: docId,
      ...(allowedProjects.length > 0 ? { project: { in: allowedProjects } } : {}),
    },
  });

  if (!doc) throw new Error(`Documento '${docId}' não encontrado ou sem permissão de acesso.`);

  const url = await getPresignedDownloadUrl(doc.s3Key, expiresInSeconds);

  return {
    download_url: url,
    expires_in_seconds: expiresInSeconds,
    filename: doc.filename,
  };
}

export interface UploadDocInput {
  filename: string;
  content_markdown: string;
  project: string;
  module?: string;
  category: string;
  tags?: string[];
  userId: string;
  allowedProjects: string[];
}

export async function uploadDoc(input: UploadDocInput): Promise<{
  doc_id: string;
  status: string;
  indexing_status: string;
  message: string;
}> {
  const { filename, content_markdown, project, module, category, tags = [], userId, allowedProjects } = input;

  if (allowedProjects.length > 0 && !allowedProjects.includes(project)) {
    throw new Error(`Sem permissão para fazer upload no projeto '${project}'.`);
  }

  const validation = validateMarkdown(filename, content_markdown);

  if (!validation.valid) {
    const doc = await prisma.document.create({
      data: {
        title: extractTitle(content_markdown),
        filename,
        project,
        module,
        category,
        status: "rejected",
        tags,
        s3Key: `rejected/${userId}/${Date.now()}_${filename}`,
        createdBy: userId,
      },
    });

    throw new Error(
      `Validação falhou: ${validation.errors.join("; ")}. doc_id temporário: ${doc.id}`
    );
  }

  const docId = crypto.randomUUID();
  const s3Key = buildS3Key(project, docId, filename);

  await uploadMarkdown(s3Key, content_markdown);

  const title = extractTitle(content_markdown);
  const metadataFromDoc = extractMetadata(content_markdown);

  const doc = await prisma.document.create({
    data: {
      id: docId,
      title,
      filename,
      project,
      module: module ?? metadataFromDoc.module,
      category: metadataFromDoc.category ?? category,
      status: validation.warnings.length > 3 ? "review_required" : "active",
      tags: [...new Set([...tags, ...(metadataFromDoc.tags ?? [])])],
      s3Key,
      createdBy: userId,
    },
  });

  await indexDocumentChunks(doc.id, content_markdown);

  return {
    doc_id: doc.id,
    status: doc.status,
    indexing_status: "completed",
    message:
      doc.status === "review_required"
        ? "Documento recebido, mas requer revisão antes de ser publicado."
        : "Documento recebido, validado e indexado com sucesso.",
  };
}

async function indexDocumentChunks(documentId: string, content: string): Promise<void> {
  const sections = content.split(/\n#{1,3} /);

  const chunks = sections
    .filter((s) => s.trim().length > 50)
    .map((section, index) => {
      const lines = section.split("\n");
      const sectionTitle = lines[0]?.trim();
      const chunkContent = lines.slice(1).join("\n").trim();

      return {
        documentId,
        sectionTitle: sectionTitle || null,
        chunkIndex: index,
        content: chunkContent || section.trim(),
      };
    })
    .filter((c) => c.content.length > 20);

  if (chunks.length > 0) {
    await prisma.documentChunk.createMany({ data: chunks });
  }
}

export async function listRecentDocs(
  project: string | undefined,
  module: string | undefined,
  limit: number,
  allowedProjects: string[]
): Promise<{ documents: Array<{ doc_id: string; title: string; filename: string; project: string; module: string | null; category: string; updated_at: string }> }> {
  const where: Record<string, unknown> = { status: "active" };

  if (allowedProjects.length > 0) {
    where.project = { in: allowedProjects };
  }

  if (project) where.project = { contains: project, mode: "insensitive" };
  if (module) where.module = { contains: module, mode: "insensitive" };

  const docs = await prisma.document.findMany({
    where,
    take: Math.min(limit, 50),
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      filename: true,
      project: true,
      module: true,
      category: true,
      updatedAt: true,
    },
  });

  return {
    documents: docs.map((d) => ({
      doc_id: d.id,
      title: d.title,
      filename: d.filename,
      project: d.project,
      module: d.module,
      category: d.category,
      updated_at: d.updatedAt.toISOString(),
    })),
  };
}

export function suggestDocTemplate(input: {
  category: string;
  project: string;
  module?: string;
  problem?: string;
}): { filename_suggestion: string; content_markdown: string } {
  const { category, project, module, problem } = input;

  const slug = (problem ?? `${category}-${project}`)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);

  const filename = `${slug}.md`;
  const date = new Date().toLocaleDateString("pt-BR");

  const content = `# ${category}: ${problem ?? `Documentação ${category} - ${project}`}

## Metadados

- **Categoria:** ${category}
- **Projeto:** ${project}
- **Módulo:** ${module ?? ""}
- **Autor:** Automático pela API key
- **Data de criação:** ${date}
- **Última atualização:** ${date}
- **Status:** Ativo
- **Tags:**

---

## 1. Contexto

Descreva o contexto do problema, melhoria, decisão ou procedimento.

## 2. Problema ou dor identificada

Descreva claramente qual era o problema.

## 3. Impacto

Quem era afetado e qual era a gravidade.

## 4. Causa raiz

O motivo técnico do problema.

## 5. Solução aplicada

A solução implementada.

## 6. Arquivos, rotas ou serviços envolvidos

-

## 7. Passo a passo

1.

## 8. Como testar

1.

## 9. Riscos ou pontos de atenção

-

## 10. Documentações relacionadas

-

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| ${date} | | Criação da documentação |
`;

  return { filename_suggestion: filename, content_markdown: content };
}
