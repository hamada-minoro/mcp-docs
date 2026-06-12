export interface SearchFilter {
  query: string;
  project?: string;
  module?: string;
  category?: string;
  limit?: number;
  allowedProjects: string[];
}

export interface DocSearchResult {
  doc_id: string;
  title: string;
  filename: string;
  project: string;
  module: string | null;
  category: string;
  status: string;
  tags: string[];
  summary: string;
  score: number;
  matched_sections: string[];
  updated_at: string;
}

export function buildSearchSql(filter: SearchFilter): {
  sql: string;
  params: (string | number | string[])[];
} {
  const params: (string | number | string[])[] = [];
  let paramIdx = 1;

  const p = () => `$${paramIdx++}`;

  const conditions: string[] = [`d.status = 'active'`];

  if (filter.allowedProjects.length > 0) {
    params.push(filter.allowedProjects);
    conditions.push(`d.project = ANY(${p()})`);
  }

  if (filter.project) {
    params.push(filter.project);
    conditions.push(`d.project ILIKE ${p()}`);
  }

  if (filter.module) {
    params.push(`%${filter.module}%`);
    conditions.push(`d.module ILIKE ${p()}`);
  }

  if (filter.category) {
    params.push(filter.category);
    conditions.push(`d.category ILIKE ${p()}`);
  }

  params.push(`%${filter.query}%`);
  const queryIdx = p();
  const ftsCondition = `(
    d.title ILIKE ${queryIdx}
    OR d.filename ILIKE ${queryIdx}
    OR ${queryIdx} = ANY(d.tags)
    OR to_tsvector('portuguese', d.title || ' ' || COALESCE(d.module, '') || ' ' || array_to_string(d.tags, ' '))
       @@ plainto_tsquery('portuguese', ${queryIdx})
  )`;
  conditions.push(ftsCondition);

  const limit = Math.min(filter.limit ?? 5, 20);
  params.push(limit);
  const limitIdx = p();

  const where = conditions.join(" AND ");

  const sql = `
    SELECT
      d.id,
      d.title,
      d.filename,
      d.project,
      d.module,
      d.category,
      d.status,
      d.tags,
      d.s3_key,
      d.updated_at,
      ts_rank(
        to_tsvector('portuguese', d.title || ' ' || COALESCE(d.module, '') || ' ' || array_to_string(d.tags, ' ')),
        plainto_tsquery('portuguese', $${paramIdx - limit.toString().length - 1})
      ) AS rank
    FROM documents d
    WHERE ${where}
    ORDER BY rank DESC, d.updated_at DESC
    LIMIT ${limitIdx}
  `;

  return { sql, params };
}
