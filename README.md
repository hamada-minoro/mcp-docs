# MCP Docs Server

Servidor MCP para centralizar documentações técnicas internas da empresa. Integra com Claude Code, VS Code, JetBrains e qualquer cliente compatível com o protocolo MCP.

A busca usa **matching semântico pela IA da IDE** — a IA lê o contexto extraído de cada documento e identifica os relevantes usando sua própria compreensão de linguagem natural, sem depender de APIs externas de embeddings.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js 20 + Express |
| Protocolo | MCP SDK (`@modelcontextprotocol/sdk`) via HTTP + SSE |
| ORM | Prisma 6 |
| Banco | PostgreSQL 16 |
| Storage de arquivos | MinIO (compatível S3) |
| Rate limiting / cache | Redis 7 |
| Validação de schema | Zod |

---

## Pré-requisitos

- Node.js 20+
- Docker e Docker Compose

---

## Setup inicial

```bash
# 1. Instalar dependências
cd docs-mcp-server
npm install

# 2. Copiar e editar variáveis de ambiente
cp .env.example .env

# 3. Subir infraestrutura (PostgreSQL + Redis + MinIO)
npm run infra:up

# 4. Criar tabelas
npm run db:migrate

# 5. Gerar Prisma Client
npm run db:generate

# 6. Criar usuários e API keys iniciais
npm run db:seed

# 7. Fazer upload dos documentos de exemplo no MinIO
npx tsx scripts/upload-example-docs.ts

# 8. Iniciar servidor (porta 3339)
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
| `list_docs_for_matching` | `docs:search` | Retorna metadados + contexto para matching semântico pela IA |
| `get_doc` | `docs:read` | Retorna conteúdo Markdown completo pelo ID |
| `download_doc` | `docs:download` | Gera URL pré-assinada de download (5 min) |
| `upload_markdown_doc` | `docs:upload` | Faz upload, extrai contexto e indexa automaticamente |
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

### Fluxo de busca

```
Usuário: "como resolver consumer-timeout no RabbitMQ?"

1. IA chama list_docs_for_matching(query: "consumer-timeout rabbitmq")
   → banco pré-filtra por texto em título, tags e context (ILIKE)
   → retorna até 50 docs com { doc_id, title, project, category, tags, context[0:500] }

2. IA lê os contextos e identifica semanticamente os relevantes
   (sem API externa — usa a própria compreensão de linguagem)

3. IA chama get_doc(doc_id) para obter o conteúdo completo
   ou download_doc(doc_id) para gerar link de download
```

### Escalabilidade

| Tamanho da base | Estratégia recomendada |
|---|---|
| Até ~200 docs | `list_docs_for_matching` sem query — IA lê todos os contextos |
| 200–1000 docs | `list_docs_for_matching(query: "termos do problema")` — pré-filtro textual reduz o conjunto |
| 1000+ docs | Pré-filtro por `project` + `category` + `query` para manter o conjunto pequeno |

O parâmetro `query` realiza `ILIKE` em título, tags, filename e no campo `context` do banco — retornando apenas candidatos texualmente relacionados para a IA analisar semanticamente.

### Upload de documento

```
Markdown recebido
  → extractTitle() + extractMetadata()   — título, categoria, projeto, módulo, tags
  → extractContext()                      — corpo sem seção de metadados nem blocos de código
  → validateMarkdown()                    — seções obrigatórias, secrets, HTML perigoso
  → MinIO/S3                             — arquivo .md completo armazenado
  → PostgreSQL documents                 — metadados + context salvos
  → PostgreSQL document_chunks           — seções indexadas por heading
```

O campo `context` extraído é o que a IA usa para matching semântico — quanto mais rico o conteúdo das seções do documento, mais precisa a identificação.

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
npx tsx scripts/upload-example-docs.ts   # Upload dos docs de exemplo no MinIO
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
