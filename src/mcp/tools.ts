import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDoc,
  generateDownloadUrl,
  uploadDoc,
  listRecentDocs,
  suggestDocTemplate,
  listDocsForMatching,
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
      "list_docs_for_matching",
      {
        description:
          "Retorna metadados e contexto semântico dos documentos para identificação semântica. " +
          "Use como PRIMEIRO passo em qualquer busca: passe query com termos do problema do usuário para " +
          "pré-filtrar no banco (título, tags, context), leia os contextos retornados, identifique os " +
          "documentos mais relevantes pela semântica e então chame get_doc ou download_doc com os doc_ids " +
          "escolhidos. Use filtros de projeto/categoria para reduzir o conjunto quando o contexto for conhecido. " +
          "Suporta paginação via limit/offset para bases grandes.",
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe(
              "Termos do problema para pré-filtro textual no banco — reduz o conjunto antes da análise semântica. " +
              "Ex: 'rabbitmq timeout', 'download 403', 'url assinada'. Omita para listar todos (use com filtros)."
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
            .max(100)
            .default(50)
            .describe("Documentos por página (máx. 100). Com query use 20–50; sem query use filtros de projeto."),
          offset: z
            .number()
            .min(0)
            .default(0)
            .describe("Posição de início para paginação. Use 0 para a primeira página."),
        },
      },
      async ({ query, project, module, category, limit, offset }) => {
        try {
          const result = await listDocsForMatching({ query, project, module, category, limit, offset, allowedProjects });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Erro ao listar documentos: ${String(error)}` }],
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
          "Retorna o conteúdo Markdown completo de uma documentação pelo ID. Use após list_docs_for_matching " +
          "ou search_docs para ler o documento inteiro — as buscas retornam apenas metadados e contexto. " +
          "O conteúdo é buscado diretamente do storage (MinIO/S3).",
        inputSchema: {
          doc_id: z.string().describe("ID do documento retornado por list_docs_for_matching ou search_docs (campo doc_id)"),
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
          doc_id: z.string().describe("ID do documento (retornado por list_docs_for_matching, search_docs ou list_recent_docs)"),
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
          "do corpo do documento, (3) armazena o arquivo completo no S3, (4) salva metadados + contexto no banco. " +
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
          "e garantir que o documento será indexado corretamente.",
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
          "docs de um projeto específico. Para busca por conteúdo ou contexto, prefira list_docs_for_matching.",
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
          "Como testar, etc.) que são indexadas no upload. Preencha as seções com detalhes técnicos " +
          "ricos para maximizar a qualidade da busca. Use antes de upload_markdown_doc.",
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
