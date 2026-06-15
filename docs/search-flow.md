# Fluxo de Busca: como a IA encontra um documento

---

## Fluxo atual: ILIKE

### Passo 1 — A IA interpreta o prompt e monta os parâmetros da tool

O prompt chega para a IA (Claude na IDE). Ela não chama a tool com o texto bruto — ela lê o prompt em linguagem natural e **extrai os filtros estruturados**:

```
Prompt: "Busque nas docs se já resolvemos problema com URL assinada
         expirando no módulo Admin do Reg+."

↓ IA interpreta e chama:

list_docs_for_matching({
  query:   "URL assinada expirando",
  project: "Reg+",
  module:  "Admin"
})
```

Isso é matching semântico da IA acontecendo *antes* de qualquer consulta ao banco — ela já filtrou projeto e módulo só de ler o texto.

---

### Passo 2 — O servidor normaliza a query antes de ir ao banco

Em `src/docs/service.ts`, `buildQueryTerms` normaliza a query:

```
"URL assinada expirando"
  → normalizeQuery()       → "url assinada expirando"   (lowercase + remove acentos)
  → split(/[^a-z0-9]+/)   → ["url", "assinada", "expirando"]
```

---

### Passo 3 — A query SQL que chega no PostgreSQL

O servidor monta filtros `AND` para projeto/módulo + um bloco `OR` para cada termo. A query efetiva fica assim:

```sql
WHERE status = 'active'
  AND project IN ('Reg+')          -- allowedProjects da API key
  AND project ILIKE '%Reg+%'       -- filtro explícito
  AND module  ILIKE '%Admin%'      -- filtro explícito
  AND (
    -- frase completa
    title    ILIKE '%url assinada expirando%'
    OR context  ILIKE '%url assinada expirando%'
    OR filename ILIKE '%url assinada expirando%'
    -- termo "url"
    OR title    ILIKE '%url%'
    OR context  ILIKE '%url%'
    -- termo "assinada"
    OR title    ILIKE '%assinada%'
    OR context  ILIKE '%assinada%'
    -- termo "expirando"
    OR title    ILIKE '%expirando%'
    OR context  ILIKE '%expirando%'
    -- tags
    OR tags @> ARRAY['url assinada expirando']
    OR tags @> ARRAY['url']
    OR tags @> ARRAY['assinada']
    OR tags @> ARRAY['expirando']
  )
ORDER BY updated_at DESC
LIMIT 50
```

O banco retorna até 50 documentos com `context` truncado nos primeiros 500 chars.

---

### Passo 4 — A IA faz o matching semântico nos contextos retornados

Aqui acontece o segundo nível de inteligência. A IA recebe algo assim:

```json
[
  {
    "doc_id": "abc-123",
    "title": "Bug: URL pré-assinada expirando em 30s no Admin",
    "project": "Reg+",
    "module": "Admin",
    "context": "O módulo Admin do Reg+ permite download de documentos
                privados. Em produção, a URL pré-assinada gerada pelo
                MinIO estava expirando em 30 segundos, causando erro
                403 para usuários que demoravam mais de 30s para clicar..."
  },
  {
    "doc_id": "def-456",
    "title": "Procedimento: Configurar CORS no Admin",
    "context": "..."
  }
]
```

A IA lê os contextos, descarta o segundo (irrelevante) e chama `get_doc("abc-123")` para buscar o Markdown completo e responder ao usuário.

---

### Limitações do ILIKE em bases maiores

| Situação | O que acontece |
|---|---|
| 500 docs e muitos usam a palavra "url" | `ILIKE '%url%'` retorna dezenas de falsos positivos, todos disputam as 50 vagas |
| Doc diz "expiração" mas a query é "expirando" | Não bate — morfologia diferente |
| Doc diz "URLs" mas a query é "url" | `ILIKE '%url%'` pega, mas "expirou" não pegaria "expirando" |
| Base com 2000 docs | Cada `ILIKE '%termo%'` faz **full table scan** — sem índice B-tree com `%` no início |

---

## Melhoria: Full-Text Search com `to_tsvector`

### A diferença fundamental: stemming

O FTS do PostgreSQL com dicionário `portuguese` reduz cada palavra à sua **raiz morfológica (lexema)**:

```
"expirando"  → lexema: "expir"
"expiração"  → lexema: "expir"    ← bate!
"expirou"    → lexema: "expir"    ← bate!
"assinada"   → lexema: "assinar"
"assinadas"  → lexema: "assinar"  ← bate!
"URLs"       → lexema: "url"      ← bate!
```

### Como fica a estrutura

No momento do **upload**, o PostgreSQL gera e armazena um `tsvector` indexado:

```sql
-- índice GIN criado uma vez na migration:
CREATE INDEX idx_documents_fts ON documents
USING gin(
  to_tsvector('portuguese',
    title || ' ' || COALESCE(context, '') || ' ' || array_to_string(tags, ' ')
  )
);
```

O GIN (Generalized Inverted Index) funciona como um índice invertido — mapeia cada lexema para os documentos que o contêm, igual ao índice no final de um livro.

### A query com FTS

```sql
WHERE status = 'active'
  AND project IN ('Reg+')
  AND module ILIKE '%Admin%'           -- filtros estruturados continuam normais
  AND to_tsvector('portuguese', title || ' ' || context || ' ' || array_to_string(tags, ' '))
      @@ plainto_tsquery('portuguese', 'URL assinada expirando')
ORDER BY ts_rank(
           to_tsvector('portuguese', title || ' ' || context),
           plainto_tsquery('portuguese', 'URL assinada expirando')
         ) DESC
LIMIT 50
```

`plainto_tsquery` converte a query em lexemas com `AND` implícito:

```
'url assinada expirando'
  → 'url' & 'assinar' & 'expir'
```

O banco usa o índice GIN para encontrar todos os docs que contêm os três lexemas — **O(log n)** em vez de O(n).

---

### Comparação direta

| Cenário | ILIKE atual | FTS com `to_tsvector` |
|---|---|---|
| "expirando" bate em "expiração" | Não | Sim (mesmo lexema: "expir") |
| "URL" bate em "URLs" | Sim (substring) | Sim (stemming) |
| "baixar" bate em "download" | Não | Não (não é sinônimo) |
| Performance com 2000 docs | Full table scan a cada query | Índice GIN — O(log n) |
| Ordenação por relevância | Não (só por `updated_at`) | `ts_rank` ordena por densidade de matches |
| Falsos positivos de substring | Alto (`%url%` pega "download_url") | Baixo (só lexemas inteiros) |

---

### Impacto prático acima de 200 docs

Com ILIKE, se você tem 1000 docs e 300 deles contêm a palavra "url" em algum lugar, os 50 retornados são os 50 **mais recentes** que batem — não os mais relevantes. A IA recebe muito ruído para filtrar.

Com FTS + `ts_rank`, os 50 retornados são os que mais mencionam os três lexemas juntos, com maior densidade — a IA recebe candidatos já ordenados por relevância textual, e o matching semântico final fica muito mais preciso.
