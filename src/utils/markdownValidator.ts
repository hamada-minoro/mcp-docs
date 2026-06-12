export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  missingRequiredSections: string[];
}

const REQUIRED_SECTIONS = ["## Metadados"];
const RECOMMENDED_SECTIONS = [
  "## 1.",
  "## 2.",
  "## 4. Causa raiz",
  "## 5. Solução",
  "## 8. Como testar",
  "## 9. Riscos",
];

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[a-zA-Z0-9]{36}/,
  /github_pat_[a-zA-Z0-9_]{82}/,
  /sk-[a-zA-Z0-9]{48}/,
  /xox[baprs]-[a-zA-Z0-9-]{10,48}/,
  /AIza[0-9A-Za-z\-_]{35}/,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
  /password\s*[:=]\s*["']?[^\s"']{8,}/i,
  /secret\s*[:=]\s*["']?[^\s"']{8,}/i,
  /token\s*[:=]\s*["']?[a-zA-Z0-9_\-]{16,}/i,
];

const DANGEROUS_HTML_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /<iframe\b/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /<object\b/gi,
  /<embed\b/gi,
];

const VALID_CATEGORIES = [
  "Bug",
  "Refatoração",
  "Procedimento",
  "Decisão técnica",
  "Operacional",
];

const VALID_STATUSES = [
  "Ativo",
  "Em revisão",
  "Obsoleto",
  "Arquivado",
];

export function validateMarkdown(
  filename: string,
  content: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingRequiredSections: string[] = [];

  if (!filename.endsWith(".md")) {
    errors.push("O arquivo deve ter extensão .md");
  }

  if (/[^a-zA-Z0-9\-_.]/u.test(filename.replace(".md", ""))) {
    warnings.push(
      "O nome do arquivo contém caracteres especiais. Prefira letras, números e hífens."
    );
  }

  const MAX_SIZE_BYTES = 1 * 1024 * 1024;
  if (Buffer.byteLength(content, "utf-8") > MAX_SIZE_BYTES) {
    errors.push("O arquivo excede o tamanho máximo de 1 MB.");
  }

  if (!content.trimStart().startsWith("#")) {
    errors.push("O documento deve iniciar com um título principal usando '#'.");
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      missingRequiredSections.push(section);
      errors.push(`Seção obrigatória não encontrada: ${section}`);
    }
  }

  for (const section of RECOMMENDED_SECTIONS) {
    if (!content.includes(section)) {
      warnings.push(`Seção recomendada não encontrada: ${section}`);
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(
        "Possível secret ou credencial detectada. Remova tokens, senhas ou chaves privadas antes de publicar."
      );
      break;
    }
  }

  for (const pattern of DANGEROUS_HTML_PATTERNS) {
    if (pattern.test(content)) {
      errors.push("Conteúdo HTML potencialmente perigoso detectado (scripts, iframes, event handlers).");
      break;
    }
  }

  const categoryMatch = content.match(/\*\*Categoria:\*\*\s*(.+)/);
  if (categoryMatch) {
    const category = categoryMatch[1].trim().split("|")[0].trim();
    if (!VALID_CATEGORIES.some((c) => category.includes(c))) {
      warnings.push(
        `Categoria '${category}' não reconhecida. Valores válidos: ${VALID_CATEGORIES.join(", ")}`
      );
    }
  }

  const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/);
  if (statusMatch) {
    const status = statusMatch[1].trim().split("|")[0].trim();
    if (!VALID_STATUSES.some((s) => status.includes(s))) {
      warnings.push(
        `Status '${status}' não reconhecido. Valores válidos: ${VALID_STATUSES.join(", ")}`
      );
    }
  }

  if (!content.includes("http://") && !content.includes("https://")) {
    // no external links — fine
  } else {
    const suspiciousLinks = (content.match(/https?:\/\/[^\s)]+/g) ?? []).filter(
      (url) =>
        !url.includes("github.com") &&
        !url.includes("docs.") &&
        !url.includes("stackoverflow") &&
        url.includes("bit.ly") ||
        url.includes("tinyurl") ||
        url.includes("t.co")
    );
    if (suspiciousLinks.length > 0) {
      warnings.push("Links encurtados ou suspeitos detectados. Verifique antes de publicar.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    missingRequiredSections,
  };
}

export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Sem título";
}

export function extractMetadata(content: string): {
  category?: string;
  project?: string;
  module?: string;
  tags?: string[];
  status?: string;
} {
  const get = (field: string): string | undefined => {
    const match = content.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*([^\\n]+)`));
    if (!match) return undefined;
    return match[1].trim().split("|")[0].trim();
  };

  const tagsMatch = content.match(/\*\*Tags:\*\*\s*([^\n]+)/);
  const tags = tagsMatch
    ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  return {
    category: get("Categoria"),
    project: get("Projeto"),
    module: get("Módulo"),
    status: get("Status"),
    tags,
  };
}
