# Anunciador — Geek Antenado

## Configurar a Shopify uma única vez (loja no Dev Dashboard)

Sua loja usa o modelo novo da Shopify (Dev Dashboard), que não mostra mais token direto na
tela — os escopos de permissão (`write_products` etc.) só podem ser definidos pela Shopify CLI.
Depois desse passo único, o painel se conecta por OAuth e renova sozinho, igual ao Mercado Livre.

No seu computador (precisa de Node.js instalado):

```bash
npm install -g @shopify/cli@latest
mkdir config-vendas-auto && cd config-vendas-auto
shopify app config link
```

Ele abre o navegador para login — escolha a organização e o app **Vendas-auto**. Isso baixa um
arquivo `shopify.app.toml` na pasta. Abra esse arquivo e garanta estas linhas (crie se não existir):

```toml
[access_scopes]
scopes = "write_products,read_products,write_inventory,read_inventory,read_locations,write_publications"

[auth]
redirect_urls = ["https://SEU-DOMINIO/auth/shopify/callback"]
```

Troque `SEU-DOMINIO` pelo domínio real da VPS (o mesmo do `BASE_URL` do `.env`). Depois:

```bash
shopify app deploy
```

Confirme a criação da nova versão. Isso publica os escopos — sem isso o token nunca vai ter
permissão para criar produto, não importa como for gerado.

No `.env` do painel, preencha:
- `SHOPIFY_API_KEY` — o "ID do cliente" (já vem preenchido)
- `SHOPIFY_API_SECRET` — em Configurações do app → Chave secreta → ícone do olho → copiar

Suba o painel (`docker compose up -d --build`) e abra `https://SEU-DOMINIO/auth/shopify` **uma
vez** — ele te leva para a tela de autorização da própria Shopify, você confirma, e pronto: o
token fica salvo em `data/shopify_token.json` e o painel nunca mais pede nada.


Painel próprio para cadastrar produtos na Shopify e no Mercado Livre ao mesmo tempo,
a partir de uma pasta de fotos do Google Drive. Roda na sua VPS, sem depender de chat.

## Subir na VPS

```bash
git clone <seu-repo> anunciador && cd anunciador
cp .env.example .env && nano .env      # preencher as chaves
docker compose up -d --build
```

O `docker-compose.yml` já sobe o **Caddy** junto, que gera e renova o certificado HTTPS sozinho
usando o domínio do `Caddyfile`. Só precisa:
1. Ter um registro DNS tipo A apontando um subdomínio (ex. `anuncios.geekantenado.com`) para o
   IP da VPS.
2. Conferir se o nome no `Caddyfile` é o mesmo do `BASE_URL` do `.env`.
3. Portas 80 e 443 abertas no firewall da VPS.

Depois de rodar `docker compose up -d --build`, aguarde 1-2 minutos para o certificado ser
emitido e acesse `https://SEU-SUBDOMINIO` normalmente — sem precisar configurar Nginx.

Abrir `https://SEU-SUBDOMINIO/auth/ml` e `https://SEU-SUBDOMINIO/auth/shopify` uma única vez cada,
para conectar as duas contas. Os tokens ficam em `data/` e se renovam sozinhos.

## Uso — uma tela só

1. **Nome do produto** — escreva como marca + modelo (ex. "Xiaomi Redmi Note 14 Pro 5G"). É a
   partir dele que o painel busca as fotos, deriva marca/modelo e monta o título do Mercado Livre.
2. **Pasta de fotos** — vem preenchida com a pasta padrão; troque se o produto estiver em outra.
   As fotos são buscadas automaticamente pelo nome do produto (arquivos `Nome do Produto (1).jpg`,
   `(2).jpg`...) — não precisa selecionar uma por uma.
3. **EAN** — cole quando tiver a caixa em mãos; pode deixar em branco.
4. **Preço Shopify** e **Preço Mercado Livre** — separados de propósito, cada plataforma tem o
   seu. Deixe um em branco pra anunciar só na outra.
5. **Anunciar** — busca as fotos, gera a descrição por IA (se `GEMINI_API_KEY` ou
   `ANTHROPIC_API_KEY` estiver configurada; senão sai um texto básico), detecta a categoria do Mercado Livre sozinho, e
   publica nas duas plataformas com barra de progresso passo a passo.

Sem foto encontrada pra esse nome, o painel avisa e não publica em nenhuma plataforma — evita
criar rascunho vazio na Shopify ou o Mercado Livre recusar por falta de imagem.

## O que já vem no padrão do canal

- Título sempre em CAIXA ALTA
- Descrição: aviso de produto usado em testes → intro → ✅ destaques → 📌 fechamento
- SKU `MARCA-MODELO`, estoque rastreado (confere depois de criar e corrige se a Shopify não
  tiver marcado `tracked: true` de fato)
- Shopify: ACTIVE + `publishablePublish` na Loja Virtual (DRAFT se não houver fotos)
- Mercado Livre: `condition: used`, `listing_type_id: gold_special` (Clássico),
  categoria por `domain_discovery` com fallback no `category_predictor`,
  Mercado Envios `me2` pago pelo comprador, garantia do vendedor 30 dias,
  `family_name` (com fallback para `title`), fotos por upload multipart, EAN em GTIN

## Fica manual

- Peso do produto (aba Frete do Shopify) — a API do painel não seta peso.
- Atributos que o ML só exige depois da publicação (ficha técnica opcional) continuam no admin do ML.

## Requisitos de pasta

Fotos nomeadas `Nome Exato do Produto (1).jpg`, `(2).jpg`… e a pasta compartilhada
como "qualquer pessoa com o link". O painel serve as imagens em `/img/<id>` — é essa
URL que Shopify e Mercado Livre consomem, então `BASE_URL` precisa ser o domínio público.
