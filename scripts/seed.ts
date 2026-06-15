import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { generateApiKey, ADMIN_SCOPES, COLLABORATOR_SCOPES } from "../src/utils/apiKey.js";
import { extractContext } from "../src/utils/markdownValidator.js";

const prisma = new PrismaClient();

const EXAMPLE_MARKDOWN = `# Bug: Correção de download no módulo Admin

## Metadados

- **Categoria:** Bug
- **Projeto:** Reg+
- **Módulo:** Admin
- **Autor:** Automático pela API key
- **Data de criação:** 11/06/2026
- **Última atualização:** 11/06/2026
- **Status:** Ativo
- **Tags:** download, storage, url-assinada, s3

---

## 1. Contexto

O módulo Admin do projeto Reg+ permite que colaboradores façam download de documentos armazenados no storage privado. O processo utiliza URLs pré-assinadas geradas pelo serviço de armazenamento.

## 2. Problema ou dor identificada

Usuários reportavam erro ao tentar baixar documentos. A requisição retornava erro 403 (Access Denied) intermitentemente.

## 3. Impacto

Todos os usuários do módulo Admin eram afetados. O problema ocorria com maior frequência em conexões mais lentas ou quando o servidor estava sob carga alta.

## 4. Causa raiz

A URL pré-assinada para download estava sendo gerada com tempo de expiração de 30 segundos. Em situações de latência mais alta ou fila de processamento no servidor, o redirect chegava ao storage após a expiração da URL.

## 5. Solução aplicada

Aumentado o tempo de expiração da URL pré-assinada de 30 para 300 segundos (5 minutos). Adicionado também um cache da URL gerada no Redis para evitar regeneração desnecessária em múltiplas requisições simultâneas.

## 6. Arquivos, rotas ou serviços envolvidos

- \`src/docs/service.ts\` — função \`generateDownloadUrl\`
- \`src/storage/minio.ts\` — função \`getPresignedDownloadUrl\`
- \`GET /v1/docs/:id/download-url\` — endpoint de geração de URL

## 7. Passo a passo

1. Identificar o parâmetro \`expiresIn\` na chamada \`getSignedUrl\`.
2. Alterar de \`{ expiresIn: 30 }\` para \`{ expiresIn: 300 }\`.
3. Adicionar cache Redis com TTL de 240 segundos (margem de 60s antes da expiração real).
4. Deploy e monitorar logs de erro 403.

## 8. Como testar

1. Gerar uma URL de download via ferramenta \`download_doc\` no MCP.
2. Aguardar 30 segundos e tentar acessar a URL — deve continuar funcionando.
3. Aguardar 300 segundos — URL deve expirar corretamente.
4. Verificar no Redis se a chave de cache foi criada: \`redis-cli keys "download:*"\`

## 9. Riscos ou pontos de atenção

- URLs com TTL mais longo aumentam janela de exposição em caso de vazamento. Avaliar se 5 minutos é adequado para o nível de sensibilidade dos documentos.
- O cache Redis deve ser invalidado quando o documento for deletado ou sua chave S3 alterada.

## 10. Documentações relacionadas

- Documentação do MinIO sobre URLs pré-assinadas
- Política de segurança de acesso a documentos

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| 11/06/2026 | Admin | Criação da documentação |
`;

async function main() {
  console.log("🌱 Iniciando seed...\n");

  const admin = await prisma.user.upsert({
    where: { email: "admin@empresa.com" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@empresa.com",
      role: "admin",
      active: true,
    },
  });

  const collab = await prisma.user.upsert({
    where: { email: "dev@empresa.com" },
    update: {},
    create: {
      name: "Dev Colaborador",
      email: "dev@empresa.com",
      role: "collaborator",
      active: true,
    },
  });

  const adminKey = generateApiKey("dev");
  await prisma.apiKey.create({
    data: {
      userId: admin.id,
      keyPrefix: adminKey.prefix,
      keyHash: adminKey.hash,
      scopes: ADMIN_SCOPES,
      allowedProjects: [],
      status: "active",
    },
  });

  const collabKey = generateApiKey("dev");
  await prisma.apiKey.create({
    data: {
      userId: collab.id,
      keyPrefix: collabKey.prefix,
      keyHash: collabKey.hash,
      scopes: COLLABORATOR_SCOPES,
      allowedProjects: ["SafeDocs", "Reg+", "SafeCard"],
      status: "active",
    },
  });

  const context = extractContext(EXAMPLE_MARKDOWN);

  const exampleDoc = await prisma.document.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: { context },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Correção de download na api",
      filename: "correcao-download-admin.md",
      project: "Reg+",
      module: "Admin",
      category: "Bug",
      status: "active",
      tags: ["download", "storage", "url-assinada", "s3"],
      s3Key: "docs/reg+/bug/admin/00000000-0000-0000-0000-000000000001/correcao-download-admin.md",
      context,
      createdBy: admin.id,
    },
  });

  await prisma.documentChunk.deleteMany({ where: { documentId: exampleDoc.id } });
  await prisma.documentChunk.createMany({
    data: [
      {
        documentId: exampleDoc.id,
        sectionTitle: "Contexto",
        chunkIndex: 0,
        content:
          "O módulo Admin do projeto Reg+ permite que colaboradores façam download de documentos armazenados no storage privado. O processo utiliza URLs pré-assinadas geradas pelo serviço de armazenamento.",
      },
      {
        documentId: exampleDoc.id,
        sectionTitle: "Causa raiz",
        chunkIndex: 1,
        content:
          "A URL pré-assinada para download estava sendo gerada com tempo de expiração de 30 segundos. Em situações de latência mais alta ou fila de processamento no servidor, o redirect chegava ao storage após a expiração da URL.",
      },
      {
        documentId: exampleDoc.id,
        sectionTitle: "Solução aplicada",
        chunkIndex: 2,
        content:
          "Aumentado o tempo de expiração da URL pré-assinada de 30 para 300 segundos. Adicionado cache Redis com TTL de 240 segundos para evitar regeneração desnecessária em múltiplas requisições simultâneas.",
      },
    ],
  });

  console.log("✅ Seed concluído!\n");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CREDENCIAIS GERADAS (salve estas chaves agora!)");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("👑 ADMIN");
  console.log(`   Email   : ${admin.email}`);
  console.log(`   API Key : ${adminKey.raw}`);
  console.log(`   Prefix  : ${adminKey.prefix}`);
  console.log(`   Escopos : todos`);
  console.log(`   Projetos: todos`);
  console.log();
  console.log("👤 COLABORADOR");
  console.log(`   Email   : ${collab.email}`);
  console.log(`   API Key : ${collabKey.raw}`);
  console.log(`   Prefix  : ${collabKey.prefix}`);
  console.log(`   Escopos : docs:search, docs:read, docs:download, docs:upload`);
  console.log(`   Projetos: SafeDocs, Reg+, SafeCard`);
  console.log();
  console.log("📄 Documento de exemplo criado:");
  console.log("   Título : Correção de download na api");
  console.log("   ID     : 00000000-0000-0000-0000-000000000001");
  console.log("   Context: extraído automaticamente do markdown");
  console.log();
  console.log("⚠️  ATENÇÃO: As chaves acima só são exibidas uma vez!");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("Próximos passos:");
  console.log("  1. npx tsx scripts/upload-example-docs.ts  (faz upload no MinIO)");
  console.log("  2. npm run dev\n");
}

main()
  .catch((e) => {
    console.error("❌ Erro no seed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
