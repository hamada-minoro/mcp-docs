# Arquitetura e Fluxo de Comunicação

---

## 1. Visão geral da arquitetura

```mermaid
graph TB
    subgraph CLIENT["Cliente (IDE)"]
        IDE["VS Code / JetBrains / Claude.ai"]
        CC["Claude Code\n(MCP Client)"]
    end

    subgraph SERVER["MCP Docs Server · Express :3339"]
        AUTH["Auth Middleware\nBearer token → hash SHA-256"]
        RATE["Rate Limiter\n100 req/min por chave"]
        ROUTER["MCP Router\nSessões HTTP + SSE"]
        TOOLS["MCP Tools\n(registradas por escopo)"]
        SVC["Docs Service\nsearch · upload · get · download"]
        EMB["Embedding Service\nOpenAI wrapper"]
        VAL["Markdown Validator\n+ extractContext()"]
        S3["MinIO Client\nAWS SDK S3"]
    end

    subgraph INFRA["Infraestrutura (Docker)"]
        PG[("PostgreSQL 16\n+ pgvector\n:5432")]
        REDIS[("Redis 7\n:6379")]
        MINIO[("MinIO\nS3-compatible\n:9002")]
    end

    OPENAI(["OpenAI API\ntext-embedding-3-small"])

    IDE --> CC
    CC -->|"HTTP POST /mcp\nAuthorization: Bearer docsk_xxx"| AUTH
    AUTH -->|"hash → lookup api_keys"| PG
    AUTH --> RATE
    RATE -->|"incr + TTL"| REDIS
    RATE --> ROUTER
    ROUTER -->|"session map + SSE"| TOOLS
    TOOLS --> SVC
    SVC --> VAL
    SVC --> S3
    SVC --> EMB
    S3 -->|"PUT / GET .md"| MINIO
    EMB -->|"POST /embeddings"| OPENAI
    OPENAI -->|"float[1536]"| EMB
    EMB -->|"UPDATE documents\nSET embedding = vector"| PG
    SVC -->|"SELECT com\nembedding <=> query"| PG
    SVC -->|"INSERT documents\nchunks · audit_logs"| PG
    TOOLS -->|"SSE response"| ROUTER
    ROUTER -->|"HTTP response / SSE stream"| CC
    CC -->|"resposta ao usuário"| IDE
```

---

## 2. Fluxo de autenticação

```mermaid
sequenceDiagram
    participant IDE as IDE / Claude Code
    participant SRV as MCP Server
    participant PG as PostgreSQL
    participant RD as Redis

    IDE->>SRV: POST /mcp · Authorization: Bearer docsk_dev_xxxx_...
    SRV->>SRV: hashApiKey(raw) → SHA-256
    SRV->>PG: SELECT * FROM api_keys WHERE key_hash = $hash
    PG-->>SRV: { id, scopes, allowedProjects, status, expiresAt }
    alt chave inválida / revogada / expirada
        SRV-->>IDE: 401 Unauthorized
    end
    SRV->>PG: UPDATE api_keys SET last_used_at, ip_addresses
    SRV->>RD: INCR rate_limit:keyId · EXPIRE 60s
    alt limite atingido (> 100 req/min)
        SRV-->>IDE: 429 Too Many Requests
    end
    SRV->>SRV: req.authUser = { id, name, role }\nreq.authApiKey = { scopes, allowedProjects }
    SRV->>SRV: registerTools() por escopo
    SRV-->>IDE: MCP session inicializada · mcp-session-id: uuid
```

---

## 3. Fluxo de busca semântica (search_docs)

```mermaid
sequenceDiagram
    participant U as Usuário
    participant CC as Claude Code
    participant SRV as MCP Server
    participant OAI as OpenAI API
    participant PG as PostgreSQL

    U->>CC: "busque docs sobre erro no download"
    CC->>SRV: tool: search_docs · query: "erro no download"
    SRV->>OAI: POST /embeddings · input: "erro no download"
    OAI-->>SRV: float[1536]

    SRV->>PG: SELECT id, title, category, project, module, tags,\n  updated_at,\n  1 - (embedding <=> $vector) AS score\nFROM documents\nWHERE status = 'active'\n  AND embedding IS NOT NULL\nORDER BY embedding <=> $vector\nLIMIT 5

    PG-->>SRV: rows ordenadas por similaridade cosseno

    alt nenhum resultado com embedding
        SRV->>PG: fallback: SELECT ... WHERE title ILIKE '%erro%'
        PG-->>SRV: resultados textuais
    end

    SRV-->>CC: [{ doc_id, title, score: 0.87, category, project }]
    CC-->>U: "Encontrei: Correção de download na api (score: 0.87)\nUse get_doc para ver o conteúdo completo."
```

---

## 4. Fluxo de upload e indexação (upload_markdown_doc)

```mermaid
sequenceDiagram
    participant U as Usuário
    participant CC as Claude Code
    participant SRV as MCP Server
    participant MN as MinIO (S3)
    participant PG as PostgreSQL
    participant OAI as OpenAI API

    U->>CC: "faça upload desta doc sobre consumer-timeout"
    CC->>SRV: tool: upload_markdown_doc · { filename, content_markdown, project, category }

    SRV->>SRV: validateMarkdown()\n(seções, secrets, HTML perigoso)
    alt validação falhou
        SRV->>PG: INSERT documents { status: rejected }
        SRV-->>CC: erro de validação
    end

    SRV->>SRV: extractTitle()\nextractMetadata() → categoria, tags, módulo\nextractContext() → corpo sem Metadados
    SRV->>SRV: buildS3Key() → docs/reg+/bug/admin/{docId}/filename.md

    SRV->>MN: PUT {s3Key} · content-type: text/markdown
    MN-->>SRV: 200 OK

    SRV->>PG: INSERT documents\n{ title, project, module, category,\n  tags, s3_key, context, status }
    SRV->>PG: INSERT document_chunks\n(seções H1–H3 do markdown)

    SRV->>OAI: POST /embeddings\ninput: "categoria: Bug\nprojeto: Reg+\ntags: ...\n[context]"
    OAI-->>SRV: float[1536]
    SRV->>PG: UPDATE documents\nSET embedding = '[0.02, -0.14, ...]'::vector\nWHERE id = $docId

    SRV->>PG: INSERT audit_logs { action: docs:upload }
    SRV-->>CC: { doc_id, status: "active", indexing_status: "completed" }
    CC-->>U: "Documento indexado com sucesso. ID: abc-123"
```

---

## 5. Fluxo de leitura completa (get_doc + download_doc)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SRV as MCP Server
    participant PG as PostgreSQL
    participant MN as MinIO (S3)

    CC->>SRV: tool: get_doc · { doc_id }
    SRV->>PG: SELECT * FROM documents WHERE id = $docId\n  AND project IN (allowedProjects)
    PG-->>SRV: { s3_key, title, ... }
    SRV->>MN: GET {s3Key}
    MN-->>SRV: conteúdo .md em UTF-8
    SRV-->>CC: { doc_id, title, content_markdown, metadata }

    CC->>SRV: tool: download_doc · { doc_id }
    SRV->>PG: SELECT s3_key FROM documents WHERE id = $docId
    PG-->>SRV: s3_key
    SRV->>MN: getSignedUrl({ Key, expiresIn: 300 })
    MN-->>SRV: URL pré-assinada (válida 5 min)
    SRV-->>CC: { download_url, expires_in_seconds: 300, filename }
```

---

## 6. Estrutura de dados (PostgreSQL)

```
documents
├── id            UUID PK
├── title         TEXT
├── filename      TEXT
├── project       TEXT           (ex: "Reg+", "SafeDocs")
├── module        TEXT?          (ex: "Admin", "Mensageria")
├── category      TEXT           (Bug | Procedimento | Decisão técnica | ...)
├── status        TEXT           (active | review_required | rejected)
├── tags          TEXT[]
├── s3_key        TEXT           (caminho no MinIO)
├── context       TEXT?          (corpo semântico extraído do markdown)
├── embedding     vector(1536)?  (pgvector — gerado via OpenAI)
├── created_by    UUID → users
└── updated_at    TIMESTAMP

document_chunks
├── id            UUID PK
├── document_id   UUID → documents (CASCADE DELETE)
├── section_title TEXT?
├── chunk_index   INT
└── content       TEXT

api_keys
├── id              UUID PK
├── user_id         UUID → users
├── key_hash        TEXT (SHA-256)
├── scopes          TEXT[]
├── allowed_projects TEXT[]
├── status          TEXT (active | revoked | expired)
└── last_used_at    TIMESTAMP

audit_logs
├── action     TEXT  (mcp.session.created | docs:search | docs:upload | ...)
├── result     TEXT  (success | error)
└── metadata   JSONB
```

---

## 7. Estratégia de embeddings

O texto enviado ao modelo `text-embedding-3-small` combina metadados estruturados com o contexto semântico:

```
categoria: Bug
projeto: Reg+
módulo: Admin
tags: download, storage, url-assinada, s3
título: Correção de download no módulo Admin

## 1. Contexto
O módulo Admin do projeto Reg+ permite que colaboradores façam
download de documentos armazenados no storage privado...

## 4. Causa raiz
A URL pré-assinada estava sendo gerada com expiração de 30 segundos...

## 5. Solução aplicada
Aumentado o tempo de expiração de 30 para 300 segundos...
[...]
```

Isso garante que:
- Metadados estruturados influenciam a similaridade (filtros semânticos)
- O corpo do documento carrega o contexto técnico real
- Seção `## Metadados` é excluída do contexto (já está em colunas separadas)
- Blocos de código são excluídos (não agregam valor semântico)
