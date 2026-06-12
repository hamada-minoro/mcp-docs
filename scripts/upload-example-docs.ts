import "dotenv/config";
import { uploadMarkdown } from "../src/storage/minio.js";

const EXAMPLE_DOC = `# Bug: Correção de download no módulo Admin

## Metadados

- **Categoria:** Bug
- **Projeto:** Reg+
- **Módulo:** Admin
- **Autor:** Automático pela API key
- **Data de criação:** 11/06/2026
- **Última atualização:** 11/06/2026
- **Status:** Ativo
- **Tags:** download, storage, url-assinada, s3

---

## 1. Contexto

O módulo Admin do projeto Reg+ permite que colaboradores façam download de documentos armazenados no storage privado. O processo utiliza URLs pré-assinadas geradas pelo serviço de armazenamento.

## 2. Problema ou dor identificada

Usuários reportavam erro ao tentar baixar documentos. A requisição retornava erro 403 (Access Denied) intermitentemente.

## 3. Impacto

Todos os usuários do módulo Admin eram afetados. O problema ocorria com maior frequência em conexões mais lentas ou quando o servidor estava sob carga alta.

## 4. Causa raiz

A URL pré-assinada para download estava sendo gerada com tempo de expiração de 30 segundos. Em situações de latência mais alta ou fila de processamento no servidor, o redirect chegava ao storage após a expiração da URL.

## 5. Solução aplicada

Aumentado o tempo de expiração da URL pré-assinada de 30 para 300 segundos (5 minutos). Adicionado também um cache da URL gerada no Redis para evitar regeneração desnecessária em múltiplas requisições simultâneas.

## 6. Arquivos, rotas ou serviços envolvidos

- \`src/docs/service.ts\` — função \`generateDownloadUrl\`
- \`src/storage/minio.ts\` — função \`getPresignedDownloadUrl\`
- \`GET /v1/docs/:id/download-url\` — endpoint de geração de URL

## 7. Passo a passo

1. Identificar o parâmetro \`expiresIn\` na chamada \`getSignedUrl\`.
2. Alterar de \`{ expiresIn: 30 }\` para \`{ expiresIn: 300 }\`.
3. Adicionar cache Redis com TTL de 240 segundos (margem de 60s antes da expiração real).
4. Deploy e monitorar logs de erro 403.

## 8. Como testar

1. Gerar uma URL de download via ferramenta \`download_doc\` no MCP.
2. Aguardar 30 segundos e tentar acessar a URL — deve continuar funcionando.
3. Aguardar 300 segundos — URL deve expirar corretamente.
4. Verificar no Redis se a chave de cache foi criada: \`redis-cli keys "download:*"\`

## 9. Riscos ou pontos de atenção

- URLs com TTL mais longo aumentam janela de exposição em caso de vazamento. Avaliar se 5 minutos é adequado para o nível de sensibilidade dos documentos.
- O cache Redis deve ser invalidado quando o documento for deletado ou sua chave S3 alterada.

## 10. Documentações relacionadas

- Documentação do MinIO sobre URLs pré-assinadas
- Política de segurança de acesso a documentos

## 11. Histórico de alterações

| Data | Autor | Alteração |
|---|---|---|
| 11/06/2026 | Admin | Criação da documentação |
`;

async function main() {
  const s3Key = "docs/reg+/00000000-0000-0000-0000-000000000001/correcao-download-admin.md";
  console.log(`Fazendo upload do documento de exemplo para: ${s3Key}`);
  await uploadMarkdown(s3Key, EXAMPLE_DOC);
  console.log("✅ Documento de exemplo carregado no MinIO com sucesso!");
}

main().catch((e) => {
  console.error("❌ Erro:", e);
  process.exit(1);
});
