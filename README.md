# MCP Docs Server

Servidor MCP para centralizar documentações internas da empresa, acessível via Claude Code, GitHub Copilot, Cursor e qualquer cliente compatível com MCP.

## Pré-requisitos

- Node.js 20+
- Docker e Docker Compose

## Setup de desenvolvimento inicial

```bash
cd docs-mcp-server
npm install
docker compose up -d          # PostgreSQL + Redis + MinIO
npm run db:migrate             # Cria as tabelas
npm run db:generate            # Gera o Prisma Client
npm run db:seed                # Cria usuários e API keys iniciais
npx tsx scripts/upload-example-docs.ts  # Carrega documento de exemplo no MinIO
npm run dev                    # Inicia o servidor na porta 3000
```

> **Guarde as API keys exibidas pelo seed** — elas não ficam armazenadas em texto puro e não podem ser recuperadas depois.

## Configurar no Claude Code

Adicione no arquivo `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "internal-docs": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer docsk_dev_6608_482a1256e7090302fc7c1f321c9b945d811c7f0fdc022626363ffcd7005c7b8a"
      }
    }
  }
}
```

## Configurar no VS Code / GitHub Copilot

Crie `.vscode/mcp.json` na raiz do projeto:

```json
{
  "servers": {
    "internal-docs": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${input:docs_mcp_api_key}"
      }
    }
  }
}
```

## Tools disponíveis

| Tool | Escopo necessário | Descrição |
|---|---|---|
| `search_docs` | `docs:search` | Busca documentações por problema, erro ou contexto |
| `get_doc` | `docs:read` | Retorna conteúdo completo de um documento |
| `download_doc` | `docs:download` | Gera link temporário de download (5 min) |
| `upload_markdown_doc` | `docs:upload` | Faz upload de nova documentação Markdown |
| `validate_markdown_doc` | `docs:upload` | Valida estrutura antes do upload |
| `list_recent_docs` | `docs:search` | Lista documentações recentes por projeto/módulo |
| `suggest_doc_template` | `docs:search` | Gera template Markdown no padrão da empresa |

## Exemplos de uso na IDE

```
Consulte o MCP internal-docs: existe documentação sobre erro de consumer-timeout no RabbitMQ?

Busque nas docs internas se já resolvemos problema com URL assinada expirada na Reg+.

Faça upload deste arquivo como documentação do projeto Reg+, categoria Bug, módulo Admin.

Gere um template de documentação para um Bug no projeto BV, módulo Mensageria.
```

## Infraestrutura local

| Serviço | URL |
|---|---|
| MCP Server | http://localhost:3000 |
| MinIO Console | http://localhost:9003 (usuário: minioadmin / senha: minioadmin) |
| PostgreSQL | localhost:5432 (user: postgres / pass: postgres / db: mcp_docs) |
| Redis | localhost:6379 |

## Scripts úteis

```bash
npm run dev            # Servidor com hot-reload
npm test               # Roda os 39 testes automatizados
npm run test:mcp       # Teste end-to-end com MCP SDK (requer TEST_API_KEY)
npm run db:studio      # Prisma Studio — visualizar banco
npm run infra:down     # Para todos os containers
```

## Variáveis de ambiente (.env)

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_docs
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9002
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=mcp-docs-internal
S3_FORCE_PATH_STYLE=true
PORT=3000
```
