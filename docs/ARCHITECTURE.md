# Arquitetura e Fluxo de Comunicação

---

## 1. Visão geral da arquitetura

```mermaid
graph TB
    subgraph CLIENT["Cliente (IDE)"]
        IDE["VS Code / JetBrains / Claude.ai"]
        CC["IA da IDE\n(MCP Client + matching semântico)"]
    end

    subgraph SERVER["MCP Docs Server · Express :3339"]
        AUTH["Auth Middleware\nBearer token → hash SHA-256"]
        RATE["Rate Limiter\n100 req/min por chave"]
        ROUTER["MCP Router\nSessões HTTP + SSE"]
        TOOLS["MCP Tools\n(registradas por escopo)"]
        SVC["Docs Service\nlist · upload · get · download"]
        ADMINSVC["Admin Service\ncreateUser · generateApiKey"]
        VAL["Markdown Validator\n+ extractContext()"]
        S3["MinIO Client\nAWS SDK S3"]
    end

    subgraph INFRA["Infraestrutura (Docker)"]
        PG[("PostgreSQL 16\n:5432")]
        REDIS[("Redis 7\n:6379")]
        MINIO[("MinIO\nS3-compatible\n:9002")]
    end

    IDE --> CC
    CC -->|"HTTP POST /mcp\nAuthorization: Bearer docsk_xxx"| AUTH
    AUTH -->|"hash → lookup api_keys"| PG
    AUTH --> RATE
    RATE -->|"incr + TTL"| REDIS
    RATE --> ROUTER
    ROUTER -->|"session map + SSE"| TOOLS
    TOOLS --> SVC
    TOOLS --> ADMINSVC
    SVC --> VAL
    SVC --> S3
    S3 -->|"PUT / GET .md"| MINIO
    SVC -->|"SELECT documents\nWHERE context ILIKE + filtros"| PG
    SVC -->|"INSERT documents\nchunks · audit_logs"| PG
    ADMINSVC -->|"INSERT users · api_keys · audit_logs"| PG
    TOOLS -->|"SSE response"| ROUTER
    ROUTER -->|"HTTP response / SSE stream"| CC
    CC -->|"matching semântico\n(compreensão de linguagem)"| CC
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

## 3. Fluxo de busca semântica (list_docs_for_matching)

A busca semântica é realizada pela própria IA da IDE, sem APIs externas. O servidor fornece os contextos extraídos; a IA decide a relevância usando compreensão de linguagem natural.

```mermaid
sequenceDiagram
    participant U as Usuário
    participant CC as IA da IDE
    participant SRV as MCP Server
    participant PG as PostgreSQL
    participant MN as MinIO (S3)

    U->>CC: "busque docs sobre erro no download"

    CC->>SRV: tool: list_docs_for_matching\n· query: "erro download"\n· project: "SafeDocs" (opcional)
    SRV->>PG: SELECT id, title, project, module, category, tags,\n  context[0:500]\nFROM documents\nWHERE status = 'active'\n  AND (title ILIKE '%erro download%'\n    OR context ILIKE '%erro download%'\n    OR tags @> ARRAY['erro download'])\nORDER BY updated_at DESC\nLIMIT 50
    PG-->>SRV: candidatos pré-filtrados por texto
    SRV-->>CC: [{ doc_id, title, project, category, tags, context }]

    Note over CC: IA analisa os contextos semanticamente<br/>identifica os documentos relevantes<br/>sem chamada a API externa

    CC->>SRV: tool: get_doc · { doc_id: "abc-123" }
    SRV->>PG: SELECT * FROM documents WHERE id = $docId
    PG-->>SRV: { s3_key, title, ... }
    SRV->>MN: GET {s3Key}
    MN-->>SRV: conteúdo .md em UTF-8
    SRV-->>CC: { doc_id, title, content_markdown, metadata }

    CC-->>U: resposta baseada no conteúdo do documento
```

### Estratégia de escalabilidade

| Tamanho da base | Uso recomendado |
|---|---|
| Até ~200 docs | `list_docs_for_matching()` sem query — IA lê todos os contextos diretamente |
| 200–1000 docs | `list_docs_for_matching(query: "termos do problema")` — pré-filtro textual reduz o conjunto |
| 1000+ docs | Combinar `project` + `category` + `query` — manter resultado abaixo de ~50 docs |

O campo `context` retornado é truncado a **500 caracteres** — suficiente para a IA avaliar relevância sem sobrecarregar o contexto da conversa.

---

## 4. Fluxo de upload e indexação (upload_markdown_doc)

```mermaid
sequenceDiagram
    participant U as Usuário
    participant CC as IA da IDE
    participant SRV as MCP Server
    participant MN as MinIO (S3)
    participant PG as PostgreSQL

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

    SRV->>PG: INSERT audit_logs { action: docs:upload }
    SRV-->>CC: { doc_id, status: "active", indexing_status: "completed" }
    CC-->>U: "Documento indexado com sucesso. ID: abc-123"
```

---

## 5. Fluxo de leitura completa (get_doc + download_doc)

```mermaid
sequenceDiagram
    participant CC as IA da IDE
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
├── context       TEXT?          (corpo semântico extraído do markdown — base do matching)
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
├── action     TEXT  (mcp.session.created | docs:search | docs:upload | admin.user.created | ...)
├── result     TEXT  (success | error)
└── metadata   JSONB
```

---

## 7. Campo context — base do matching semântico

O campo `context` é extraído no upload via `extractContext()`. Ele remove a seção `## Metadados` e blocos de código, preservando o texto das seções de conteúdo:

```
## 1. Contexto
O módulo Admin do projeto Reg+ permite que colaboradores façam
download de documentos armazenados no storage privado...

## 4. Causa raiz
A URL pré-assinada estava sendo gerada com expiração de 30 segundos...

## 5. Solução aplicada
Aumentado o tempo de expiração de 30 para 300 segundos...
[...]
```

Quanto mais detalhadas as seções do documento, melhor o matching semântico — a IA recebe os primeiros 500 caracteres deste campo para avaliar relevância antes de buscar o conteúdo completo.

---

## 8. Fluxo de criação de usuário (create_user)

A tool `create_user` é exclusiva do escopo `admin:keys`. Ela cria o usuário, gera a API key e registra no audit log em uma única chamada. A chave raw só existe neste retorno — o servidor armazena apenas o hash SHA-256.

```mermaid
sequenceDiagram
    participant U as Admin
    participant CC as IA da IDE
    participant SRV as MCP Server
    participant PG as PostgreSQL

    U->>CC: "Crie um usuário chamado João Silva,\ne-mail joao@empresa.com, role collaborator,\ncom acesso apenas ao projeto Reg+"

    CC->>SRV: tool: create_user\n· name: "João Silva"\n· email: "joao@empresa.com"\n· role: "collaborator"\n· allowed_projects: ["Reg+"]

    SRV->>PG: SELECT * FROM users WHERE email = 'joao@empresa.com'
    PG-->>SRV: (vazio — e-mail disponível)

    SRV->>PG: INSERT INTO users { name, email, role: "collaborator", active: true }
    PG-->>SRV: { id: "uuid-do-usuario" }

    SRV->>SRV: generateApiKey("live")\n→ raw: "docsk_live_xxxx_..."\n→ hash: SHA-256(raw)\n→ scopes: COLLABORATOR_SCOPES

    SRV->>PG: INSERT INTO api_keys\n{ user_id, key_hash, scopes, allowed_projects: ["Reg+"], status: "active" }
    SRV->>PG: INSERT INTO audit_logs { action: "admin.user.created", target_id: userId }

    SRV-->>CC: { user_id, name, email, role,\napi_key: "docsk_live_xxxx_...",\nscopes, allowed_projects,\nwarning: "Guarde esta API key agora..." }

    CC-->>U: exibe as credenciais geradas
```

### Escopos concedidos por role

| Role | Escopos da API key gerada |
|---|---|
| `admin` | `docs:search`, `docs:read`, `docs:download`, `docs:upload`, `docs:update`, `docs:delete`, `admin:keys`, `admin:audit` |
| `collaborator` | `docs:search`, `docs:read`, `docs:download`, `docs:upload` |
| `readonly` | `docs:search`, `docs:read`, `docs:download` |

---

## 9. Banco de dados e alternativas de infraestrutura

O projeto usa PostgreSQL como única dependência de banco de dados. O matching semântico é realizado pela própria IA da IDE, sem extensões vetoriais ou APIs externas — o PostgreSQL é usado apenas para persistência de metadados e busca textual via `ILIKE`.

Para rodar em ambiente gerenciado sem Docker local, qualquer serviço PostgreSQL-compatible funciona sem mudança de código:

| Opção | Descrição |
|---|---|
| **Neon** | PostgreSQL serverless, free tier generoso |
| **Supabase** | PostgreSQL gerenciado com painel web |
| **RDS PostgreSQL** | Gerenciado na AWS |
| **Aurora Serverless v2** | PostgreSQL-compatible, escala para zero |

> Veja [postgres-vs-dynamodb.md](postgres-vs-dynamodb.md) para a análise de viabilidade de migração para DynamoDB.
