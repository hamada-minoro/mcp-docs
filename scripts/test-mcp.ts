import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const API_KEY = process.env.TEST_API_KEY ?? process.argv[2];
const BASE_URL = process.env.MCP_URL ?? "http://localhost:3000/mcp";

if (!API_KEY) {
  console.error("Uso: npx tsx scripts/test-mcp.ts <api-key>");
  console.error("  ou defina TEST_API_KEY no .env");
  process.exit(1);
}

async function main() {
  console.log(`\n🔌 Conectando ao MCP em ${BASE_URL}...\n`);

  const transport = new StreamableHTTPClientTransport(new URL(BASE_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    console.log("✅ Conectado ao MCP Server!\n");

    const { tools } = await client.listTools();
    console.log(`📦 Tools disponíveis (${tools.length}):`);
    tools.forEach((t) => console.log(`   - ${t.name}: ${t.description?.slice(0, 60)}...`));
    console.log();

    console.log("🔍 Testando search_docs (query: 'download')...");
    const searchResult = await client.callTool({
      name: "search_docs",
      arguments: { query: "download", limit: 3 },
    });
    const searchContent = searchResult.content[0] as { type: string; text: string };
    const parsed = JSON.parse(searchContent.text);
    console.log(`   Resultados: ${parsed.results?.length ?? 0} documento(s) encontrado(s)`);
    if (parsed.results?.[0]) {
      console.log(`   Primeiro resultado: ${parsed.results[0].title}`);
    }
    console.log();

    if (parsed.results?.[0]?.doc_id) {
      const docId = parsed.results[0].doc_id;

      console.log(`📄 Testando get_doc (doc_id: ${docId})...`);
      const docResult = await client.callTool({
        name: "get_doc",
        arguments: { doc_id: docId },
      });
      const docContent = docResult.content[0] as { type: string; text: string };
      const doc = JSON.parse(docContent.text);
      console.log(`   Título: ${doc.title}`);
      console.log(`   Projeto: ${doc.metadata?.project}`);
      console.log();

      console.log(`🔗 Testando download_doc (doc_id: ${docId})...`);
      const dlResult = await client.callTool({
        name: "download_doc",
        arguments: { doc_id: docId },
      });
      const dlContent = dlResult.content[0] as { type: string; text: string };
      const dl = JSON.parse(dlContent.text);
      console.log(`   URL: ${dl.download_url?.slice(0, 60)}...`);
      console.log(`   Expira em: ${dl.expires_in_seconds}s`);
      console.log();
    }

    console.log("📋 Testando list_recent_docs...");
    const listResult = await client.callTool({
      name: "list_recent_docs",
      arguments: { limit: 5 },
    });
    const listContent = listResult.content[0] as { type: string; text: string };
    const list = JSON.parse(listContent.text);
    console.log(`   ${list.documents?.length ?? 0} documento(s) recente(s)`);
    console.log();

    console.log("📝 Testando suggest_doc_template...");
    const templateResult = await client.callTool({
      name: "suggest_doc_template",
      arguments: {
        category: "Bug",
        project: "SafeDocs",
        module: "Admin",
        problem: "erro ao gerar URL assinada",
      },
    });
    const templateContent = templateResult.content[0] as { type: string; text: string };
    const template = JSON.parse(templateContent.text);
    console.log(`   Arquivo sugerido: ${template.filename_suggestion}`);
    console.log();

    console.log("✅ Validando Markdown...");
    const validateResult = await client.callTool({
      name: "validate_markdown_doc",
      arguments: {
        filename: "test.md",
        content_markdown: "# Test\n\nConteúdo sem metadados.",
      },
    });
    const validateContent = validateResult.content[0] as { type: string; text: string };
    const validation = JSON.parse(validateContent.text);
    console.log(`   Válido: ${validation.valid}`);
    console.log(`   Erros: ${validation.errors?.length ?? 0}`);
    console.log(`   Avisos: ${validation.warnings?.length ?? 0}`);
    console.log();

    if (tools.find((t) => t.name === "upload_markdown_doc")) {
      console.log("📤 Testando upload_markdown_doc...");
      const uploadContent = `# Bug: Teste de Upload via MCP

## Metadados

- **Categoria:** Bug
- **Projeto:** SafeDocs
- **Módulo:** Admin
- **Autor:** Automático pela API key
- **Data de criação:** ${new Date().toLocaleDateString("pt-BR")}
- **Última atualização:** ${new Date().toLocaleDateString("pt-BR")}
- **Status:** Ativo
- **Tags:** teste, upload, mcp

---

## 1. Contexto

Documento de teste criado pelo script de teste MCP.

## 2. Problema ou dor identificada

Teste de integração do endpoint de upload.

## 3. Impacto

Baixo — apenas teste.

## 4. Causa raiz

N/A — documento de teste.

## 5. Solução aplicada

N/A — documento de teste.

## 6. Arquivos, rotas ou serviços envolvidos

- scripts/test-mcp.ts

## 7. Passo a passo

1. Executar \`npm run test:mcp\`

## 8. Como testar

1. Verificar se o documento aparece no list_recent_docs

## 9. Riscos ou pontos de atenção

Nenhum.

## 10. Documentações relacionadas

N/A

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| ${new Date().toLocaleDateString("pt-BR")} | Script de teste | Criação |
`;

      const uploadResult = await client.callTool({
        name: "upload_markdown_doc",
        arguments: {
          filename: `teste-upload-${Date.now()}.md`,
          content_markdown: uploadContent,
          project: "SafeDocs",
          module: "Admin",
          category: "Bug",
          tags: ["teste", "upload"],
        },
      });
      const uploadRes = uploadResult.content[0] as { type: string; text: string };
      const uploadData = JSON.parse(uploadRes.text);
      console.log(`   Status: ${uploadData.status}`);
      console.log(`   doc_id: ${uploadData.doc_id}`);
      console.log(`   Mensagem: ${uploadData.message}`);
      console.log();
    }

    console.log("🎉 Todos os testes passaram!\n");
  } catch (error) {
    console.error("❌ Erro durante o teste:", error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
