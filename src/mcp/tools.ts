import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchDocs,
  getDoc,
  generateDownloadUrl,
  uploadDoc,
  listRecentDocs,
  suggestDocTemplate,
} from "../docs/service.js";
import { validateMarkdown } from "../utils/markdownValidator.js";

export function registerTools(server: McpServer, context: {
  userId: string;
  apiKeyId: string;
  scopes: string[];
  allowedProjects: string[];
}): void {
  const { userId, scopes, allowedProjects } = context;

  if (scopes.includes("docs:search")) {
    server.registerTool(
      "search_docs",
      {
        description:
          "Busca documentações internas por problema, erro, contexto ou termos técnicos usando busca semântica " +
          "(pgvector + embeddings OpenAI). Encontra documentos por similaridade de significado, não apenas por " +
          "palavras-chave exatas — funciona mesmo que o usuário use termos diferentes dos presentes na documentação. " +
          "Use sempre que o colaborador perguntar sobre bugs, erros, procedimentos, decisões técnicas ou soluções já " +
          "implementadas. Retorna documentos ordenados por score de relevância (0–1). Após obter resultados, use " +
          "get_doc para ler o conteúdo completo do documento mais relevante.",
        inputSchema: {
          query: z
            .string()
            .describe(
              "Descrição do problema, erro ou contexto em linguagem natural (ex: 'erro 403 no download', " +
              "'consumer-timeout RabbitMQ', 'URL pré-assinada expirando')"
            ),
          project: z
            .string()
            .optional()
            .describe("Filtrar por projeto (ex: SafeDocs, Reg+, SafeCard). Omita para buscar em todos."),
          module: z
            .string()
            .optional()
            .describe("Filtrar por módulo dentro do projeto (ex: Admin, Mensageria, Pagamentos)"),
          category: z
            .string()
            .optional()
            .describe(
              "Filtrar por categoria: Bug | Procedimento | Decisão técnica | Refatoração | Operacional"
            ),
          limit: z
            .number()
            .min(1)
            .max(20)
            .default(5)
            .describe("Quantidade máxima de resultados. Use 1–3 para perguntas específicas, até 10 para exploração."),
        },
      },
      async ({ query, project, module, category, limit }) => {
        try {
          const results = await searchDocs({ query, project, module, category, limit, allowedProjects });
          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro ao buscar documentações: ${String(error)}` }],
            isError: true,
          };
        }
      }
    );
  }

  if (scopes.includes("docs:read")) {
    server.registerTool(
      "get_doc",
      {
        description:
          "Retorna o conteúdo Markdown completo de uma documentação pelo ID. Use após search_docs para ler " +
          "o documento inteiro — a busca retorna apenas metadados e score. O conteúdo é buscado diretamente " +
          "do storage (MinIO/S3).",
        inputSchema: {
          doc_id: z.string().describe("ID do documento retornado pelo search_docs (campo doc_id)"),
        },
      },
      async ({ doc_id }) => {
        try {
          const doc = await getDoc(doc_id, allowedProjects);
          return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro ao obter documento: ${String(error)}` }],
            isError: true,
          };
        }
      }
    );
  }

  if (scopes.includes("docs:download")) {
    server.registerTool(
      "download_doc",
      {
        description:
          "Gera um link temporário de download (válido por 5 minutos) para uma documentação Markdown. " +
          "Retorna uma URL pré-assinada do storage. Use quando o colaborador precisar baixar o arquivo " +
          "localmente ou compartilhar com alguém.",
        inputSchema: {
          doc_id: z.string().describe("ID do documento (retornado por search_docs ou list_recent_docs)"),
        },
      },
      async ({ doc_id }) => {
        try {
          const result = await generateDownloadUrl(doc_id, allowedProjects);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro ao gerar link: ${String(error)}` }],
            isError: true,
          };
        }
      }
    );
  }

  if (scopes.includes("docs:upload")) {
    server.registerTool(
      "upload_markdown_doc",
      {
        description:
          "Faz upload e indexa automaticamente uma documentação Markdown na base interna. O servidor: " +
          "(1) valida estrutura e escaneia por secrets, (2) extrai título, metadados e contexto semântico " +
          "do corpo do documento, (3) armazena o arquivo completo no S3, (4) salva metadados + contexto no " +
          "banco, (5) gera embedding vetorial via OpenAI para busca semântica futura. " +
          "Use somente com conteúdo técnico — sem senhas, tokens ou dados sensíveis. " +
          "Para garantir qualidade, use validate_markdown_doc antes ou suggest_doc_template para criar " +
          "o documento no formato correto.",
        inputSchema: {
          filename: z
            .string()
            .describe("Nome do arquivo .md em kebab-case (ex: bug-rabbitmq-consumer-timeout.md)"),
          content_markdown: z
            .string()
            .describe(
              "Conteúdo completo do Markdown, incluindo a seção ## Metadados com Categoria, Projeto, " +
              "Módulo, Tags e as seções de conteúdo (Contexto, Causa raiz, Solução, etc.)"
            ),
          project: z.string().describe("Projeto ao qual pertence (ex: SafeDocs, Reg+, SafeCard)"),
          module: z.string().optional().describe("Módulo dentro do projeto (ex: Admin, Mensageria)"),
          category: z
            .enum(["Bug", "Refatoração", "Procedimento", "Decisão técnica", "Operacional"])
            .describe("Categoria da documentação"),
          tags: z
            .array(z.string())
            .optional()
            .describe(
              "Tags adicionais para busca (ex: ['rabbitmq', 'timeout', 'consumer']). " +
              "As tags da seção ## Metadados são extraídas automaticamente."
            ),
        },
      },
      async ({ filename, content_markdown, project, module, category, tags }) => {
        try {
          const result = await uploadDoc({
            filename, content_markdown, project, module, category, tags, userId, allowedProjects,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro no upload: ${String(error)}` }],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "validate_markdown_doc",
      {
        description:
          "Valida a estrutura de um Markdown sem fazer upload. Verifica seções obrigatórias " +
          "(## Metadados, ## 1. Contexto, etc.), categoria válida, ausência de secrets/tokens e " +
          "HTML perigoso. Use antes de upload_markdown_doc para corrigir problemas antecipadamente " +
          "e garantir que o documento será indexado corretamente na busca semântica.",
        inputSchema: {
          filename: z.string().describe("Nome do arquivo .md (deve terminar com .md)"),
          content_markdown: z.string().describe("Conteúdo completo do Markdown a validar"),
        },
      },
      async ({ filename, content_markdown }) => {
        const result = validateMarkdown(filename, content_markdown);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );
  }

  if (scopes.includes("docs:search")) {
    server.registerTool(
      "list_recent_docs",
      {
        description:
          "Lista documentações recentes de um projeto ou módulo, ordenadas por data de atualização. " +
          "Use para explorar o que existe na base, ver documentos recém-adicionados ou listar todas as " +
          "docs de um projeto específico. Para busca por conteúdo, prefira search_docs.",
        inputSchema: {
          project: z
            .string()
            .optional()
            .describe("Filtrar por projeto (ex: Reg+, SafeDocs). Omita para listar de todos."),
          module: z.string().optional().describe("Filtrar por módulo (ex: Admin, Mensageria)"),
          limit: z
            .number()
            .min(1)
            .max(50)
            .default(10)
            .describe("Quantidade de resultados (máx. 50)"),
        },
      },
      async ({ project, module, limit }) => {
        try {
          const result = await listRecentDocs(project, module, limit, allowedProjects);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro ao listar: ${String(error)}` }],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "suggest_doc_template",
      {
        description:
          "Gera um template Markdown no padrão interno da empresa para uma nova documentação. " +
          "O template inclui todas as seções obrigatórias (Metadados, Contexto, Causa raiz, Solução, " +
          "Como testar, etc.) que são indexadas semanticamente no upload. Preencha as seções com " +
          "detalhes técnicos ricos para maximizar a qualidade da busca semântica. " +
          "Use antes de upload_markdown_doc para garantir o formato correto.",
        inputSchema: {
          category: z
            .enum(["Bug", "Refatoração", "Procedimento", "Decisão técnica", "Operacional"])
            .describe("Tipo de documentação — define quais seções são geradas no template"),
          project: z.string().describe("Projeto (ex: SafeDocs, Reg+, SafeCard)"),
          module: z.string().optional().describe("Módulo dentro do projeto"),
          problem: z
            .string()
            .optional()
            .describe(
              "Descrição breve do problema ou tema (ex: 'consumer-timeout no RabbitMQ ao processar " +
              "fila de notificações'). Usado para gerar título e sugestão de filename."
            ),
        },
      },
      async ({ category, project, module, problem }) => {
        const result = suggestDocTemplate({ category, project, module, problem });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}
