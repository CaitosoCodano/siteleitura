# Entrelinhas V5.4 — modo sem R2 (Cloudflare Workers + D1)

Esta edição é para quem **não quer ativar o R2 nem cadastrar cartão para hospedagem de mídias**. Utiliza somente o Worker e o banco D1 já existentes. **Não publica automaticamente** o site ao baixar o ZIP.

## Novidades da V5.4 — Layout para desktop e celular

- **Computador (janela ≥ 960px):** menu esquerdo e painel direito visíveis e imóveis; somente a área central (`main#main`) rola. O topo permanece parado. Quando as laterais são maiores que a tela, elas têm rolagem independente, sem levar a coluna toda junto.
- **Celular e tablet (janela < 960px):** layout adaptativo com botão **☰** para abrir o menu lateral em uma gaveta. Toque em um item para navegar e fechar; feche também pelo X, fundo escuro ou Escape. Barra de navegação inferior preservada. Não força duas laterais em telas estreitas.
- **Emojis:** botão **☺ Emoji** abre e fecha um painel com **6 categorias e mais de 120 opções**. Compatível com posts, resenhas e comentários, no PC e celular. Nenhuma mídia é armazenada.
- Sem alterar backend, esquema do D1, senhas, convites, perfis ou mensagens. **Não é necessário executar nova migração para esta atualização de interface** se o banco já estava na V5.3.

## Novidades

- Feed com busca por trecho, nome do leitor, título ou autor do livro, filtros de resenhas/pensamentos e ordenação por mais recentes ou mais interações (somente entre as publicações carregadas pela API).
- Busca instantânea de leitores na Comunidade, por nome ou biografia. Nenhum perfil ou estatística fictícia foi criado.
- Seletor de emojis em posts, comentários e resenhas, sem custo de mídia.
- Corrigido um erro JavaScript da página Explorar livros (`b is not defined`) que podia impedir resultados de aparecer.
- Interface adaptável a 100% de zoom, com Sair da conta disponível na barra lateral ou no Perfil.
- Sem campo de upload de foto/vídeo/capa: nesta versão o R2 foi **desabilitado de propósito**. Avatares por emoji e capas da Open Library continuam funcionando. Vídeos enviados em versões com R2 dependem dele para reproduzir.

## Preservação e migração

O Worker V5.4 mantém o nome `entrelinhas-siteleitura`, o banco `entrelinhas-db` e o `database_id` incluído em `wrangler.jsonc`. Confira se corresponde ao seu banco antes de atualizar. **Não altere `AUTH_PEPPER` nem `INVITE_CODE`**, nem execute migrações destrutivas. A migração `0002_media.sql` é aditiva e necessária para compatibilidade com o esquema V5.2 (mesmo que o bucket R2 não seja ativado). Se já foi aplicada, o comando de migração não a repete.

## Instalar via PowerShell

Extraia o ZIP em uma nova pasta e, dentro da pasta que contém package.json:

```powershell
npm install
npx wrangler d1 export entrelinhas-db --remote --output=backup-entrelinhas.sql
npm run db:remote
npm test
npm run deploy
```

**Atenção**: o backup é recomendado antes da migração. Confirme que o comando de exportação foi concluído com sucesso antes de prosseguir. O deploy é manual e deve exibir o endereço público do Worker.

Link do site: https://entrelinhas-siteleitura.minhacan.workers.dev

## O que é gratuito / limitações

Não habilite R2 nem configure uma assinatura R2 para esta versão. Workers e D1 têm cotas gratuitas limitadas; excedê-las pode provocar erro ou indisponibilidade no nível Free, e planos pagos têm condições distintas. A versão **não garante custo zero em uma conta que já esteja usando serviços pagos**. Consulte seu painel e mantenha Workers/D1 no nível gratuito. As melhorias de filtro usam o navegador e não fazem consultas ao D1 ao digitar. Não há upload de fotos ou vídeos sem armazenamento externo.

Se no futuro decidir hospedar mídias, podemos adicionar um provedor com cotas claras. Enquanto isso, esta versão dispensa cobrança por armazenamento R2.

## Testes práticos após deploy

1. Entre com a conta existente, confira se o perfil continua igual.
2. No início, pesquise uma postagem, filtre Resenhas e ordene por Mais interações.
3. Em Comunidade, pesquise um leitor pelo nome.
4. Em Explorar livros, pesquise uma obra real e adicione-a à estante.
5. Publique resenha com emojis e abra os comentários.
6. Verifique o botão Sair da conta no zoom 100%.

## Teste de interface V5.4 depois de publicar

1. **Desktop:** abra no Chrome, Edge ou Firefox em 100% de zoom, role o feed: menus esquerdo e direito permanecem visíveis. O botão **Sair da conta** deve estar disponível na coluna esquerda (se a altura for pequena, role só aquela coluna).
2. **Celular:** entre no site, toque em **☰** no alto à esquerda, navegue e confira o fechamento do menu. A barra de navegação inferior continua visível.
3. **Emojis:** escreva um comentário, toque em **☺ Emoji**, selecione categoria e emoji. Repita ao escrever resenha no modal e postagem no feed.
4. Caso o navegador mostre versão antiga, faça atualização completa (Ctrl+F5 no desktop) ou abra uma aba anônima.

Não use `wrangler secret put` novamente, não recrie o D1 e não ative o R2 para esta edição. Se **0002_media.sql** já tiver sido aplicada na instalação V5.3, não é preciso rodar `npm run db:remote` de novo. Para publicar: `npm install`, `npm test`, `npm run deploy`.
