# Entrelinhas · Rede social privada de livros (versão Render + GitHub)

Projeto funcional e independente de Supabase: **Node.js 22 + SQLite nativo**, com frontend responsivo, cadastro e login por e-mail/senha, acesso **somente com código de convite**, perfis, resenhas reais, estantes, publicações, comentários, curtidas e seguidores. Login Google é opcional, caso você configure sua própria credencial Google Cloud. **Não há perfis, livros, estatísticas ou posts de demonstração.**

## Como publicar pelo GitHub → Render

1. **Crie um repositório privado no GitHub** (por exemplo, `entrelinhas`). Extraia o ZIP e envie **todos os arquivos da pasta `entrelinhas-render` para a raiz do repositório**, incluindo `render.yaml`. Não envie `.env` nem arquivos `.sqlite`.
2. Entre em [Render](https://dashboard.render.com/) → **New** → **Blueprint** → conecte seu GitHub e selecione esse repositório. O `render.yaml` cria **um Web Service pago de entrada (`0.5c-512mb`) e um disco persistente de 1 GB em `/var/data`**.
3. Na criação do Blueprint, defina `INVITE_CODE` com um código forte e secreto (ao menos 8 caracteres, idealmente 20+). Distribua o código **somente aos convidados**. Não coloque esse código em arquivo público/GitHub.
4. `GOOGLE_CLIENT_ID` é **opcional** e não precisa ser configurado no primeiro deploy. O login por e-mail e senha funciona normalmente. Se quiser ativar Google, crie a variável manualmente no painel Render mais tarde.
5. Aguarde o deploy. Abra `https://SEU-NOME.onrender.com`. A primeira pessoa cria uma conta com o convite; as próximas usam o mesmo código.
6. As alterações futuras no GitHub causam novo deploy. O SQLite fica em **`/var/data/entrelinhas.sqlite` e permanece no disco**.

**Importante sobre custos:** Render *Free* não permite disco persistente: você perderia os dados ao reiniciar, adormecer ou atualizar o serviço. Este Blueprint escolhe o plano **Starter (pago)** exatamente para não perder resenhas e contas. Confirme o preço do serviço e do disco no painel do Render antes de criar. O SQLite não exige Supabase nem banco de dados separado.

## Se preferir criar um Web Service manualmente

- Runtime: **Node**, Node versão 22.16.0 ou mais recente dentro da linha 22.
- Build command: `echo "No build needed"`
- Start command: `npm start`
- Plan: **0.5c-512mb ou superior** (pago)
- Mount persistent disk: `/var/data` (1 GB costuma bastar para texto e metadados de poucas pessoas)
- Environment: `NODE_ENV=production`, `DB_PATH=/var/data/entrelinhas.sqlite`, `INVITE_CODE=<seu código secreto>`, `GOOGLE_CLIENT_ID=<opcional>`
- Health check path: `/api/health`

## Testar no computador antes do Render

Instale **Node.js >= 22.13.0**; as dependências são zero (`node:sqlite` vem no Node 22 e nesta versão ainda emite um aviso experimental).

```bash
cp .env.example .env
# edite .env com um convite secreto de verdade
npm start
# abra http://localhost:3000
```

No Windows, copie `.env.example` para `.env` pelo Explorador de Arquivos. `npm test` executa o teste de integração automatizado criando contas reais em um banco temporário.

## Login com Google (opcional)

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), configure uma tela de consentimento OAuth e crie um **OAuth Client ID do tipo Web application**.
2. Adicione **Authorized JavaScript origins**: `https://SEU-NOME.onrender.com` (ou seu domínio próprio). Para teste local, adicione `http://localhost:3000`.
3. No Render, adicione `GOOGLE_CLIENT_ID` com esse client ID, como `...apps.googleusercontent.com`, e redeploy.
4. Com login Google ativo, contas Google ainda desconhecidas deverão inserir o código de convite na aba **Criar minha conta**. Contas existentes com o mesmo e-mail verificado poderão entrar e vincular o Google à conta.

O backend verifica a assinatura RS256 do ID token do Google e confirma emissor, audiência, expiração e e-mail verificado. Sem `GOOGLE_CLIENT_ID`, a opção fica invisível.

## Segurança e privacidade

- Contas com e-mail, senhas protegidas com `scrypt` + salt; nenhuma senha em texto puro.
- Cookie de sessão aleatória, `HttpOnly`, `SameSite=Lax`, `Secure` em produção; tokens armazenados como hash no banco.
- Endpoints sociais exigem login. Sem login só são acessíveis a tela de autenticação, endpoints de login/cadastro, configuração pública e health check.
- Convite obrigatório para novas contas; opção de login Google não abre inscrições públicas.
- Não existe criação automática de usuários, avaliações, seguidores ou resenhas.
- **Privado** aqui significa *comunidade fechada com autenticação*, mas o endereço de login do Web Service continua acessível publicamente na internet. Para rede totalmente inacessível sem VPN, seria necessária arquitetura de rede privada diferente.
- O projeto não implementa redefinição de senha por e-mail, uploads de imagens, moderação administrativa, e-mails de confirmação ou backups agendados. Para acesso muito restrito com convidados de confiança, use convites secretos e faça backups regulares.
- O código de convite compartilhado pode ser reutilizado; para bloquear novas inscrições depois que o grupo estiver pronto, troque `INVITE_CODE` no Render sem afetar contas existentes. Convidados antigos não conseguem criar novas contas com o código antigo.
- O projeto salva textos dos posts e resenhas, não cópias dos livros protegidos por direitos autorais.

## Estrutura

```
entrelinhas-render/
├── server.js           # API HTTP e banco SQLite, sem dependências externas
├── public/
│   ├── index.html      # frontend
│   ├── style.css       # tema editorial responsivo
│   └── app.js          # interação com API real
├── tests/integration.test.js
├── render.yaml         # Blueprint Render + disco persistente
├── package.json
├── .env.example
└── .gitignore
```

**Backup do banco:** fazer backup do arquivo `/var/data/entrelinhas.sqlite` com segurança, usando snapshot do disco ou rotina de backup que faça uma cópia SQLite consistente. Não basta copiar o arquivo enquanto o banco está em WAL sem garantir checkpoint/backup. Consulte a documentação de snapshots/backups do Render. Não coloque backups com dados privados no GitHub.
