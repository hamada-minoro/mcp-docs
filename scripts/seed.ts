import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { generateApiKey, ADMIN_SCOPES, COLLABORATOR_SCOPES } from "../src/utils/apiKey.js";

const prisma = new PrismaClient();

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

  const exampleDoc = await prisma.document.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Correção de download na api",
      filename: "correcao-download-admin.md",
      project: "Reg+",
      module: "Admin",
      category: "Bug",
      status: "active",
      tags: ["download", "storage", "url-assinada", "s3"],
      s3Key: "docs/reg+/00000000-0000-0000-0000-000000000001/correcao-download-admin.md",
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
        content: "O erro ocorria durante o processo de download de documentos no módulo Admin do SafeDocs.",
      },
      {
        documentId: exampleDoc.id,
        sectionTitle: "Causa raiz",
        chunkIndex: 1,
        content: "A URL assinada para download no S3 estava expirando antes do redirect ser processado. O tempo de expiração estava definido como 30 segundos, insuficiente para redes mais lentas.",
      },
      {
        documentId: exampleDoc.id,
        sectionTitle: "Solução aplicada",
        chunkIndex: 2,
        content: "Aumentado o tempo de expiração da URL pré-assinada de 30 para 300 segundos. Também foi adicionado cache do token de download no Redis para evitar regeneração desnecessária.",
      },
    ],
  });

  console.log("✅ Seed concluído!\n");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  CREDENCIAIS GERADAS (salve estas chaves agora!)");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("👑 ADMIN");
  console.log(`   Email : ${admin.email}`);
  console.log(`   API Key: ${adminKey.raw}`);
  console.log(`   Prefix : ${adminKey.prefix}`);
  console.log();
  console.log("👤 COLABORADOR");
  console.log(`   Email : ${collab.email}`);
  console.log(`   API Key: ${collabKey.raw}`);
  console.log(`   Prefix : ${collabKey.prefix}`);
  console.log(`   Projetos:  Reg+, BV`);
  console.log();
  console.log("📄 Documento de exemplo criado: correcao-download-admin.md");
  console.log("   ID: 00000000-0000-0000-0000-000000000001");
  console.log();
  console.log("⚠️  ATENÇÃO: As chaves acima só são exibidas uma vez!");
  console.log("═══════════════════════════════════════════════════════\n");
}

main()
  .catch((e) => {
    console.error("❌ Erro no seed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
