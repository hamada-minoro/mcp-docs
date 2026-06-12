# MCP Docs Server

Servidor MCP para centralizar documentações técnicas internas da empresa. Integra com Claude Code, VS Code, JetBrains e qualquer cliente compatível com o protocolo MCP.

A busca usa **embeddings vetoriais (pgvector + OpenAI)** — encontra documentos por similaridade semântica, não por palavras-chave exatas. Perguntar sobre "erro 403 no download" encontra a doc "Correção de download na api" mesmo sem correspondência textual.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js 20 + Express |
| Protocolo | MCP SDK (`@modelcontextprotocol/sdk`) via HTTP + SSE |
| ORM | Prisma 6 |
| Banco | PostgreSQL 16 + extensão `pgvector` |
| Busca semântica | OpenAI `text-embedding-3-small` + pgvector cosine similarity |
| Storage de arquivos | MinIO (compatível S3) |
| Rate limiting / cache | Redis 7 |
| Validação de schema | Zod |

---

## Pré-requisitos

- Node.js 20+
- Docker e Docker Compose
- Conta OpenAI com créditos (para embeddings)

---

## Setup inicial

```bash
# 1. Instalar dependências
cd docs-mcp-server
npm install

# 2. Copiar e editar variáveis de ambiente
cp .env.example .env
# Edite .env e preencha OPENAI_API_KEY

# 3. Subir infraestrutura (PostgreSQL + Redis + MinIO)
npm run infra:up

# 4. Criar tabelas + extensão pgvector
npm run db:migrate

# 5. Gerar Prisma Client
npm run db:generate

# 6. Criar usuários e API keys iniciais
npm run db:seed

# 7. Fazer upload do documento de exemplo no MinIO
npx tsx scripts/upload-example-docs.ts

# 8. Gerar embeddings dos documentos existentes
npx tsx scripts/reindex-embeddings.ts

# 9. Iniciar servidor (porta 3339)
npm run dev
```

> **Guarde as API keys exibidas pelo seed** — elas são geradas com hash SHA-256 e não podem ser recuperadas depois.

---

## Variáveis de ambiente

```env
# Banco de dados
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_docs

# Redis (rate limiting)
REDIS_URL=redis://localhost:6379

# MinIO (storage de arquivos Markdown)
S3_ENDPOINT=http://localhost:9002
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=mcp-docs-internal
S3_FORCE_PATH_STYLE=true

# OpenAI (embeddings para busca semântica)
OPENAI_API_KEY=sk-...

# Servidor
PORT=3339
NODE_ENV=development

# Segurança
API_KEY_SECRET_LENGTH=32
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_SECONDS=60
```

---

## Configurar no Claude Code

Adicione em `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "internal-docs": {
      "type": "http",
      "url": "http://localhost:3339/mcp",
      "headers": {
        "Authorization": "Bearer docsk_dev_xxxx_<sua-api-key>"
      }
    }
  }
}
```

## Configurar no VS Code

Crie `.vscode/mcp.json` na raiz do workspace:

```json
{
  "servers": {
    "internal-docs": {
      "type": "http",
      "url": "http://localhost:3339/mcp",
      "headers": {
        "Authorization": "Bearer ${input:docs_mcp_api_key}"
      }
    }
  }
}
```

---

## Tools MCP disponíveis

| Tool | Escopo | Descrição |
|---|---|---|
| `search_docs` | `docs:search` | Busca semântica por problema, erro ou contexto |
| `get_doc` | `docs:read` | Retorna conteúdo Markdown completo pelo ID |
| `download_doc` | `docs:download` | Gera URL pré-assinada de download (5 min) |
| `upload_markdown_doc` | `docs:upload` | Faz upload, extrai contexto e gera embedding automaticamente |
| `validate_markdown_doc` | `docs:upload` | Valida estrutura antes do upload |
| `list_recent_docs` | `docs:search` | Lista documentações recentes por projeto/módulo |
| `suggest_doc_template` | `docs:search` | Gera template Markdown no padrão da empresa |

### Escopos por perfil

| Perfil | Escopos |
|---|---|
| Admin | todos (`docs:*` + `admin:keys` + `admin:audit`) |
| Colaborador | `docs:search`, `docs:read`, `docs:download`, `docs:upload` |
| Somente leitura | `docs:search`, `docs:read`, `docs:download` |

---

## Como a busca semântica funciona

### Upload de documento

```
Markdown recebido
  → extractTitle() + extractMetadata()   — título, categoria, projeto, módulo, tags
  → extractContext()                      — corpo sem seção de metadados nem blocos de código
  → MinIO/S3                             — arquivo .md completo armazenado
  → PostgreSQL documents                 — metadados + context salvos
  → PostgreSQL document_chunks           — seções indexadas por heading
  → OpenAI text-embedding-3-small        — embedding gerado do texto:
      "categoria: Bug
       projeto: Reg+
       módulo: Admin
       tags: download, s3
       título: Correção de download na api
       [context completo]"
  → PostgreSQL documents.embedding       — vetor float[1536] armazenado
```

### Busca

```
Query: "erro 403 no download"
  → OpenAI text-embedding-3-small        — embedding da query (float[1536])
  → pgvector: ORDER BY embedding <=> query_vector  — distância cosseno
  → Retorna documentos ordenados por score (0–1)
  → Fallback automático para ILIKE se OPENAI_API_KEY não configurado
```

---

## Infraestrutura local

| Serviço | URL / Acesso |
|---|---|
| MCP Server | http://localhost:3339 |
| Health check | http://localhost:3339/health |
| MinIO Console | http://localhost:9003 — `minioadmin` / `minioadmin` |
| PostgreSQL | `localhost:5432` — `postgres` / `postgres` / db: `mcp_docs` |
| Redis | `localhost:6379` |

---

## Scripts

```bash
npm run dev                               # Servidor com hot-reload
npm run build                             # Compila TypeScript
npm test                                  # Roda testes (Vitest)
npm run test:mcp                          # Teste e2e com MCP SDK
npm run db:migrate                        # Aplica migrations pendentes
npm run db:generate                       # Regenera Prisma Client
npm run db:seed                           # Cria usuários e API keys de dev
npm run db:studio                         # Prisma Studio (visualizar banco)
npm run infra:up                          # Sobe PostgreSQL + Redis + MinIO
npm run infra:down                        # Para os containers
npx tsx scripts/upload-example-docs.ts   # Upload do doc de exemplo no MinIO
npx tsx scripts/reindex-embeddings.ts    # Gera embeddings para docs sem vetor
```

---

## Exemplos de uso na IDE

```
Consulte o MCP internal-docs: existe documentação sobre erro de consumer-timeout no RabbitMQ?

Busque nas docs se já resolvemos problema com URL assinada expirando no módulo Admin do Reg+.

Faça upload deste arquivo como documentação do projeto Reg+, categoria Bug, módulo Mensageria.

Gere um template de documentação para um Bug no projeto SafeDocs, módulo Admin.

Liste as documentações mais recentes do projeto Reg+.
```

---

## Arquitetura e fluxo de comunicação

Veja [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para os diagramas completos.
