import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  uploadMarkdown,
  getMarkdownContent,
  getPresignedDownloadUrl,
  buildS3Key,
  buildRejectedS3Key,
} from "../storage/minio.js";
import {
  validateMarkdown,
  extractTitle,
  extractMetadata,
  extractContext,
} from "../utils/markdownValidator.js";

const CONTEXT_PREVIEW_LENGTH = 500;
const MIN_TERM_LENGTH = 2;

function normalizeQuery(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildQueryTerms(rawQuery: string): string[] {
  const normalized = normalizeQuery(rawQuery);

  const terms = normalized
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= MIN_TERM_LENGTH);

  return [...new Set(terms)];
}

export interface ListDocsForMatchingInput {
  query?: string;
  project?: string;
  module?: string;
  category?: string;
  limit?: number;
  offset?: number;
  allowedProjects: string[];
}

export interface DocForMatching {
  doc_id: string;
  title: string;
  project: string;
  module: string | null;
  category: string;
  tags: string[];
  context: string;
}

export async function listDocsForMatching(
  input: ListDocsForMatchingInput
): Promise<{ docs: DocForMatching[]; total: number }> {
  const { query, project, module, category, limit = 50, offset = 0, allowedProjects } = input;

  const baseFilters: Prisma.DocumentWhereInput[] = [{ status: "active" }];

  if (allowedProjects.length > 0) {
    baseFilters.push({ project: { in: allowedProjects } });
  }
  if (project) {
    baseFilters.push({ project: { contains: project, mode: "insensitive" } });
  }
  if (module) {
    baseFilters.push({ module: { contains: module, mode: "insensitive" } });
  }
  if (category) {
    baseFilters.push({ category: { contains: category, mode: "insensitive" } });
  }

  let queryFilter: Prisma.DocumentWhereInput | undefined;
  const trimmedQuery = query?.trim();
  if (trimmedQuery) {
    const queryTerms = buildQueryTerms(trimmedQuery);

    const queryOrFilters: Prisma.DocumentWhereInput[] = [
      { title: { contains: trimmedQuery, mode: "insensitive" } },
      { context: { contains: trimmedQuery, mode: "insensitive" } },
      { filename: { contains: trimmedQuery, mode: "insensitive" } },
      { tags: { hasSome: [trimmedQuery.toLowerCase()] } },
    ];

    for (const term of queryTerms) {
      queryOrFilters.push(
        { title: { contains: term, mode: "insensitive" } },
        { context: { contains: term, mode: "insensitive" } },
        { filename: { contains: term, mode: "insensitive" } },
        { tags: { hasSome: [term] } }
      );
    }

    queryFilter = { OR: queryOrFilters };
  }

  const where: Prisma.DocumentWhereInput = queryFilter
    ? { AND: [...baseFilters, queryFilter] }
    : { AND: baseFilters };

  const queryOptions = {
    take: Math.min(limit, 100),
    skip: offset,
    orderBy: { updatedAt: "desc" as const },
    select: {
      id: true,
      title: true,
      project: true,
      module: true,
      category: true,
      tags: true,
      context: true,
    },
  };

  const [docs, total] = await Promise.all([
    prisma.document.findMany({
      where,
      ...queryOptions,
    }),
    prisma.document.count({ where }),
  ]);

  // Fallback para evitar retornos vazios em consultas com query muito específica.
  // A IA local ainda fará o matching semântico usando os contextos retornados.
  if (trimmedQuery && docs.length === 0) {
    const fallbackWhere: Prisma.DocumentWhereInput = { AND: baseFilters };
    const [fallbackDocs, fallbackTotal] = await Promise.all([
      prisma.document.findMany({
        where: fallbackWhere,
        ...queryOptions,
      }),
      prisma.document.count({ where: fallbackWhere }),
    ]);

    return {
      docs: fallbackDocs.map((d) => ({
        doc_id: d.id,
        title: d.title,
        project: d.project,
        module: d.module,
        category: d.category,
        tags: d.tags,
        context: (d.context ?? "").slice(0, CONTEXT_PREVIEW_LENGTH),
      })),
      total: fallbackTotal,
    };
  }

  return {
    docs: docs.map((d) => ({
      doc_id: d.id,
      title: d.title,
      project: d.project,
      module: d.module,
      category: d.category,
      tags: d.tags,
      context: (d.context ?? "").slice(0, CONTEXT_PREVIEW_LENGTH),
    })),
    total,
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
    context: string;
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
      context: doc.context ?? "",
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

  const title = extractTitle(content_markdown);
  const metadataFromDoc = extractMetadata(content_markdown);
  const resolvedCategory = metadataFromDoc.category ?? category;
  const resolvedModule = module ?? metadataFromDoc.module;
  const context = extractContext(content_markdown);

  const validation = validateMarkdown(filename, content_markdown);

  if (!validation.valid) {
    const doc = await prisma.document.create({
      data: {
        title,
        filename,
        project,
        module: resolvedModule,
        category: resolvedCategory,
        status: "rejected",
        tags,
        s3Key: buildRejectedS3Key(userId, filename),
        createdBy: userId,
      },
    });

    throw new Error(
      `Validação falhou: ${validation.errors.join("; ")}. doc_id temporário: ${doc.id}`
    );
  }

  const docId = crypto.randomUUID();
  const s3Key = buildS3Key(project, resolvedCategory, docId, filename, resolvedModule);

  await uploadMarkdown(s3Key, content_markdown);

  const doc = await prisma.document.create({
    data: {
      id: docId,
      title,
      filename,
      project,
      module: resolvedModule,
      category: resolvedCategory,
      status: validation.warnings.length > 3 ? "review_required" : "active",
      tags: [...new Set([...tags, ...(metadataFromDoc.tags ?? [])])],
      s3Key,
      context,
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
  const andFilters: Prisma.DocumentWhereInput[] = [{ status: "active" }];

  if (allowedProjects.length > 0) {
    andFilters.push({ project: { in: allowedProjects } });
  }

  if (project) andFilters.push({ project: { contains: project, mode: "insensitive" } });
  if (module) andFilters.push({ module: { contains: module, mode: "insensitive" } });

  const where: Prisma.DocumentWhereInput = { AND: andFilters };

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
