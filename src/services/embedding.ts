import OpenAI from "openai";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

export function isEmbeddingEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function buildDocumentText(doc: {
  title: string;
  category: string;
  project: string;
  module?: string | null;
  tags: string[];
  context: string;
}): string {
  const lines = [
    `categoria: ${doc.category}`,
    `projeto: ${doc.project}`,
    doc.module ? `módulo: ${doc.module}` : null,
    doc.tags.length ? `tags: ${doc.tags.join(", ")}` : null,
    `título: ${doc.title}`,
    "",
    doc.context,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}
