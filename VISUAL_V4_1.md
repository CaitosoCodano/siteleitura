# Entrelinhas V4.1 — Interface ampliada

Esta atualização corrige a sensação de site reduzido na versão V4 Direct.

## Arquivos

- `public/style.css` — fontes, botões, caixas, cartões, perfis e mensagens maiores; mantém grafite + verde-petróleo.
- `public/index.html` — mesmo HTML da V4, com parâmetro de versão no CSS para atualizar o cache do navegador.

**Não inclui nem altera:** `server.js`, `app.js`, bancos SQLite, variáveis de ambiente, contas reais ou Direct.

## Atualizar pelo GitHub (PowerShell no Windows)

1. Extraia o ZIP.
2. Abra a pasta CLONADA do GitHub (`siteleitura-github` ou `siteleitura-v4`, que deve conter `.git`). Não execute `git` na pasta extraída do ZIP.
3. Copie `public/style.css` e `public/index.html` deste ZIP para a pasta `public` do repositório clonado, substituindo os existentes.
4. No terminal aberto na pasta clonada:

```powershell
git status
git add public/style.css public/index.html
git commit -m "Entrelinhas V4.1 - Interface mais legivel"
git push origin main
```

5. Aguarde o Render publicar. Recarregue a página (Ctrl+F5 no PC ou feche e reabra no navegador do celular).

## Testes

- `npm test`: 2 testes aprovados (backend da V4 preservado).
- Layout estático verificado em 320, 390, 768 e 1366 pixels: sem rolagem horizontal nas telas de autenticação, início e Direct.

Nota: screenshots de verificação do layout usam conteúdo ilustrativo **apenas durante o teste local**, não incluem usuários nem publicações pré-cadastrados no projeto.
