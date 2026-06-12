/**
 * Re-indexes all documents that are missing context or embedding.
 * Run after enabling pgvector or after adding new documents via legacy scripts.
 *
 * Usage: npx tsx scripts/reindex-embeddings.ts
 */
import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { getMarkdownContent } from "../src/storage/minio.js";
import { extractContext } from "../src/utils/markdownValidator.js";
import { buildDocumentText, generateEmbedding, isEmbeddingEnabled } from "../src/services/embedding.js";

async function main() {
  if (!isEmbeddingEnabled()) {
    console.error("❌ OPENAI_API_KEY não configurado. Configure antes de rodar este script.");
    process.exit(1);
  }

  type DocRow = { id: string; title: string; category: string; project: string; module: string | null; tags: string[]; s3_key: string; context: string | null };
  const docs = await prisma.$queryRaw<DocRow[]>`
    SELECT id, title, category, project, module, tags, s3_key, context
    FROM documents
    WHERE status IN ('active', 'review_required')
      AND (context IS NULL OR embedding IS NULL)
  `;

  if (docs.length === 0) {
    console.log("✅ Todos os documentos já estão indexados.");
    return;
  }

  console.log(`🔄 Re-indexando ${docs.length} documento(s)...\n`);

  for (const doc of docs) {
    process.stdout.write(`  [${doc.id}] ${doc.title} ... `);
    try {
      const context = doc.context ?? extractContext(await getMarkdownContent(doc.s3_key));
      const text = buildDocumentText({ ...doc, context });
      const embedding = await generateEmbedding(text);
      const vectorStr = `[${embedding.join(",")}]`;

      await prisma.$executeRaw`
        UPDATE documents
        SET context = ${context}, embedding = ${vectorStr}::vector
        WHERE id = ${doc.id}
      `;

      console.log("✅");
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
    }
  }

  console.log("\nConcluído.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
