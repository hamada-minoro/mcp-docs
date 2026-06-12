-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to documents
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- IVFFlat index for approximate cosine similarity search
-- lists=10 is appropriate for small datasets (< 1M docs); increase for larger
CREATE INDEX IF NOT EXISTS "documents_embedding_idx"
  ON "documents" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 10);
