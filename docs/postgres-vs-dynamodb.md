# Por que não migramos do PostgreSQL para o DynamoDB

## Contexto

O MCP Docs Server usa o PostgreSQL para armazenar metadados de documentos, controle de acesso (API keys, usuários) e logs de auditoria. Esta análise documenta a investigação sobre a viabilidade de substituir o PostgreSQL pelo DynamoDB e a conclusão de que a troca não é recomendada para este caso de uso.

---

## O que o projeto usa do PostgreSQL

### Tabelas e padrões de acesso

| Tabela | Padrão principal |
|---|---|
| `documents` | Lookup por ID, filtros multi-campo, text search em `title` e `context`, ORDER BY `updated_at` |
| `api_keys` | Lookup por `key_hash` (SHA-256), JOIN com `users` |
| `document_chunks` | INSERT em lote, cascade delete via FK para `documents` |
| `audit_logs` | INSERT com metadados JSONB, queries por `user_id`, `action`, `created_at` |
| `users` | Lookup por ID, retornado em JOIN com `api_keys` |

---

## Os bloqueadores da migração

### 1. Busca textual com ILIKE — bloqueador crítico

O core da ferramenta `list_docs_for_matching` faz busca por texto livre contra três campos ao mesmo tempo:

```sql
WHERE title ILIKE '%termo%'
   OR context ILIKE '%termo%'
   OR filename ILIKE '%termo%'
   OR tags @> ARRAY['termo']
```

O DynamoDB **não tem equivalente**. As alternativas seriam:

- **AWS OpenSearch ao lado do DynamoDB** — praticamente um segundo banco de dados, com custo, operação e sincronização adicional. A simplicidade seria perdida.
- **Scan completo da tabela** filtrando na aplicação — proibido em escala, caro em RCUs, latente.
- **Eliminar o pré-filtro** e passar todos os documentos para a IA avaliar — funciona até ~200 docs, degrada e onera o contexto da IA em bases maiores.

Nenhuma dessas opções mantém o desempenho e a simplicidade atuais.

### 2. Joins e foreign keys não existem no DynamoDB

A autenticação faz:

```typescript
prisma.apiKey.findFirst({
  where: { keyHash },
  include: { user: true },  // JOIN implícito
});
```

No DynamoDB isso exige duas operações separadas (GetItem em `api_keys` + GetItem em `users`), mais código de orquestração na aplicação, e sem garantia de consistência referencial.

As cascade deletes em `document_chunks → documents` também precisariam ser implementadas manualmente.

### 3. COUNT sem scan não existe no DynamoDB

A paginação usa:

```typescript
prisma.document.count({ where })
```

O DynamoDB não tem `COUNT` condicional. A única forma de contar itens com filtro é fazer um scan completo da tabela — O(n) em RCUs consumidos, caro e lento para bases grandes.

### 4. Ordenação por `updated_at` requer GSI por tabela

`ORDER BY updated_at DESC LIMIT 50` é trivial no PostgreSQL com índice B-tree. No DynamoDB, a ordenação só funciona pela sort key de um índice (GSI ou LSI). Seria necessário criar um GSI com `status` como partition key e `updated_at` como sort key — e mesmo assim a cardinalidade baixa de `status` (3 valores possíveis) criaria hot partitions.

### 5. Arrays e containment

O projeto usa `TEXT[]` para `tags`, `scopes` e `allowed_projects`. O PostgreSQL oferece operadores nativos (`@>`, `hasSome`, `IN`). O DynamoDB tem Sets, mas as operações de filtragem em Sets dentro de um scan têm semântica e desempenho diferentes.

---

## Comparação direta

| Funcionalidade | PostgreSQL | DynamoDB |
|---|---|---|
| Text search (`ILIKE`) | Nativo, usa índice com `LIKE 'termo%'` | Inexistente — precisa de OpenSearch |
| JOIN entre tabelas | Nativo, uma query | Múltiplos round trips manuais |
| `COUNT` com filtro | O(log n) com índice | O(n) — scan completo |
| `ORDER BY` em campo arbitrário | Índice B-tree | Requer GSI pré-definido |
| Cascade delete | Nativo via FK | Manual na aplicação |
| Arrays com containment | Nativo (`@>`, `hasSome`) | Limitado em filter expressions |
| JSONB (`metadata`) | Nativo | Map type (equivalente) |
| Lookup por PK | Índice clustered | Excelente (caso de uso ideal do Dynamo) |

---

## Quando o DynamoDB faria sentido

O DynamoDB brilha em cenários com padrões de acesso **previsíveis e fixos**, volume de escrita muito alto, e estrutura de dados simples. Por exemplo: um sistema de sessões, um carrinho de compras, ou uma fila de jobs com chave bem definida.

O MCP Docs Server tem padrões de acesso variados (busca textual, filtros compostos, joins), volume baixo a moderado, e estrutura relacional. PostgreSQL é a escolha certa para esse perfil.

---

## Alternativas se a necessidade for sair do Docker local

Se o objetivo for rodar em ambiente gerenciado sem manter PostgreSQL em Docker, as alternativas que **não exigem mudança de código** são:

| Opção | Descrição |
|---|---|
| **Neon** | PostgreSQL serverless, free tier generoso, zero alterações no código |
| **Supabase** | PostgreSQL gerenciado com painel web e autenticação integrada |
| **RDS PostgreSQL** | PostgreSQL gerenciado na AWS, compatível direto |
| **Aurora Serverless v2** | PostgreSQL-compatible, serverless, escala para zero |

Todas essas opções mantêm o `DATABASE_URL` como único ponto de configuração — o restante do projeto não muda.
