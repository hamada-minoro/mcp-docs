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
          "Busca documentações internas por problema, erro, contexto ou termos técnicos. Use quando o colaborador perguntar sobre um bug, procedimento, erro específico ou decisão técnica.",
        inputSchema: {
          query: z.string().describe("Descrição do problema ou termos de busca"),
          project: z.string().optional().describe("Filtrar por projeto (ex: SafeDocs, Reg+)"),
          module: z.string().optional().describe("Filtrar por módulo (ex: Admin, Mensageria)"),
          category: z
            .string()
            .optional()
            .describe("Filtrar por categoria: Bug, Procedimento, Decisão técnica, Refatoração, Operacional"),
          limit: z
            .number()
            .min(1)
            .max(20)
            .default(5)
            .describe("Quantidade máxima de resultados"),
        },
      },
      async ({ query, project, module, category, limit }) => {
        try {
          const results = await searchDocs({
            query,
            project,
            module,
            category,
            limit,
            allowedProjects,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          };
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
          "Retorna o conteúdo completo de uma documentação pelo ID. Use após search_docs para obter o documento inteiro.",
        inputSchema: {
          doc_id: z.string().describe("ID do documento retornado pelo search_docs"),
        },
      },
      async ({ doc_id }) => {
        try {
          const doc = await getDoc(doc_id, allowedProjects);
          return {
            content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
          };
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
          "Gera um link temporário de download (válido por 5 minutos) para uma documentação. Retorna URL pré-assinada.",
        inputSchema: {
          doc_id: z.string().describe("ID do documento"),
        },
      },
      async ({ doc_id }) => {
        try {
          const result = await generateDownloadUrl(doc_id, allowedProjects);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
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
          "Faz upload de uma nova documentação Markdown para a base interna. O arquivo será validado, escaneado e indexado. Use somente com conteúdo técnico — sem senhas, tokens ou dados sensíveis.",
        inputSchema: {
          filename: z.string().describe("Nome do arquivo .md (ex: bug-rabbitmq-timeout.md)"),
          content_markdown: z.string().describe("Conteúdo completo do Markdown"),
          project: z.string().describe("Projeto ao qual pertence (ex: SafeDocs)"),
          module: z.string().optional().describe("Módulo dentro do projeto (ex: Admin)"),
          category: z
            .enum(["Bug", "Refatoração", "Procedimento", "Decisão técnica", "Operacional"])
            .describe("Categoria da documentação"),
          tags: z
            .array(z.string())
            .optional()
            .describe("Tags para facilitar busca (ex: ['rabbitmq', 'timeout'])"),
        },
      },
      async ({ filename, content_markdown, project, module, category, tags }) => {
        try {
          const result = await uploadDoc({
            filename,
            content_markdown,
            project,
            module,
            category,
            tags,
            userId,
            allowedProjects,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
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
          "Valida a estrutura de um Markdown antes de publicar. Use para verificar se o documento está no formato correto antes do upload.",
        inputSchema: {
          filename: z.string().describe("Nome do arquivo .md"),
          content_markdown: z.string().describe("Conteúdo do Markdown a validar"),
        },
      },
      async ({ filename, content_markdown }) => {
        const result = validateMarkdown(filename, content_markdown);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );
  }

  if (scopes.includes("docs:search")) {
    server.registerTool(
      "list_recent_docs",
      {
        description:
          "Lista documentações recentes de um projeto ou módulo, ordenadas por data de atualização.",
        inputSchema: {
          project: z.string().optional().describe("Filtrar por projeto"),
          module: z.string().optional().describe("Filtrar por módulo"),
          limit: z.number().min(1).max(50).default(10).describe("Quantidade de resultados"),
        },
      },
      async ({ project, module, limit }) => {
        try {
          const result = await listRecentDocs(project, module, limit, allowedProjects);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
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
          "Gera um template de documentação Markdown baseado na categoria e contexto. Use para criar novos documentos no formato padrão da empresa.",
        inputSchema: {
          category: z
            .enum(["Bug", "Refatoração", "Procedimento", "Decisão técnica", "Operacional"])
            .describe("Tipo de documentação"),
          project: z.string().describe("Projeto"),
          module: z.string().optional().describe("Módulo"),
          problem: z.string().optional().describe("Descrição breve do problema ou tema"),
        },
      },
      async ({ category, project, module, problem }) => {
        const result = suggestDocTemplate({ category, project, module, problem });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );
  }
}
