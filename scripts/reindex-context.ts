/**
 * Backfills the `context` column for documents where it is NULL.
 * Fetches each document's Markdown from MinIO, runs extractContext, and updates the DB.
 *
 * Usage: npx tsx scripts/reindex-context.ts
 */
import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { getMarkdownContent } from "../src/storage/minio.js";
import { extractContext } from "../src/utils/markdownValidator.js";

async function main() {
  const docs = await prisma.document.findMany({
    where: { status: { in: ["active", "review_required"] }, context: null },
    select: { id: true, title: true, s3Key: true },
  });

  if (docs.length === 0) {
    console.log("✅ Nenhum documento com context nulo. Nada a fazer.");
    return;
  }

  console.log(`🔄 Reindexando context de ${docs.length} documento(s)...\n`);

  let ok = 0;
  let fail = 0;

  for (const doc of docs) {
    process.stdout.write(`  [${doc.id}] ${doc.title} ... `);
    try {
      const markdown = await getMarkdownContent(doc.s3Key);
      const context = extractContext(markdown);
      await prisma.document.update({ where: { id: doc.id }, data: { context } });
      console.log(`✅ (${context.length} chars)`);
      ok++;
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\nConcluído: ${ok} atualizados, ${fail} com erro.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
