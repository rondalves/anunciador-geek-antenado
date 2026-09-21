import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

const app = express();
app.use(express.json({ limit: "4mb" }));

const env = process.env;
const PORT = env.PORT || 8080;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const SHOP = env.SHOPIFY_SHOP || "geekantenado.myshopify.com";
const SHOP_API = env.SHOPIFY_API_VERSION || "2025-01";
const PUBLICATION_ID = env.SHOPIFY_PUBLICATION_ID || "gid://shopify/Publication/171235442871";
const SHOP_KEY = env.SHOPIFY_API_KEY || "";
const SHOP_SECRET = env.SHOPIFY_API_SECRET || "";
const SHOP_SCOPES = env.SHOPIFY_SCOPES ||
  "write_products,read_products,write_inventory,read_inventory,read_locations,write_publications";
const SHOP_STATIC_TOKEN = env.SHOPIFY_ADMIN_TOKEN || ""; // opcional, se algum dia existir um token fixo
const SHOP_TOKEN_FILE = path.join(DATA, "shopify_token.json");

const DRIVE_KEY = env.GOOGLE_API_KEY;
const DEFAULT_FOLDER = env.DRIVE_DEFAULT_FOLDER || "";

const ML_CLIENT_ID = env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = env.ML_REDIRECT_URI || `${BASE_URL}/auth/ml/callback`;
const ML_SITE = env.ML_SITE || "MLB";
const ML_REFRESH_SEED = env.ML_REFRESH_TOKEN || "";

const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || "";
const MODELO = env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const TOKEN_FILE = path.join(DATA, "ml_token.json");
const LOG_FILE = path.join(DATA, "publicados.json");
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

/* ---------- senha ---------- */
app.use((req, res, next) => {
  if (!env.APP_PASSWORD || req.path.startsWith("/auth/ml") || req.path.startsWith("/auth/shopify") || req.path.startsWith("/img/")) return next();
  const h = req.headers.authorization || "";
  const [, p] = Buffer.from(h.split(" ")[1] || "", "base64").toString().split(":");
  if (p === env.APP_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="anunciador"').status(401).send("Acesso restrito");
});
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Google Drive ---------- */
const folderId = (s = "") => (s.match(/[-\w]{25,}/) || [s.trim()])[0];

app.get("/api/fotos", async (req, res) => {
  try {
    if (!DRIVE_KEY) throw new Error("GOOGLE_API_KEY não configurada no .env");
    const pasta = folderId(req.query.pasta || DEFAULT_FOLDER);
    if (!pasta) throw new Error("Informe o link da pasta do Drive");
    const nome = (req.query.nome || "").trim();
    const q = [`'${pasta}' in parents`, "trashed = false", "mimeType contains 'image/'"];
    if (nome) q.push(`name contains '${nome.replace(/'/g, "\\'")}'`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q.join(" and "))}` +
      `&fields=files(id,name)&orderBy=name&pageSize=200&key=${DRIVE_KEY}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    res.json({ ok: true, files: (j.files || []).map(f => ({ id: f.id, nome: f.name, url: `${BASE_URL}/img/${f.id}` })) });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

const baixarDrive = async (id) => {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${DRIVE_KEY}`);
  if (!r.ok) throw new Error("não consegui baixar a imagem do Drive");
  return { buf: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get("content-type") || "image/jpeg" };
};

app.get("/img/:id", async (req, res) => {
  try {
    const { buf, tipo } = await baixarDrive(req.params.id);
    res.set({ "Content-Type": tipo, "Cache-Control": "public, max-age=86400" }).send(buf);
  } catch { res.status(404).send("imagem nao encontrada"); }
});

/* ---------- Shopify (OAuth, mesmo padrão do Mercado Livre) ---------- */
function shopifyToken() {
  if (SHOP_STATIC_TOKEN) return SHOP_STATIC_TOKEN;
  const t = readJson(SHOP_TOKEN_FILE, null);
  if (!t?.access_token) throw new Error(`Shopify não conectada — abra ${BASE_URL}/auth/shopify uma vez`);
  return t.access_token;
}

app.get("/auth/shopify", (req, res) => {
  if (!SHOP_KEY) return res.status(400).send("SHOPIFY_API_KEY não configurado no .env");
  const estado = crypto.randomBytes(12).toString("hex");
  res.cookie?.("shopify_state", estado);
  const u = `https://${SHOP}/admin/oauth/authorize?client_id=${SHOP_KEY}` +
    `&scope=${encodeURIComponent(SHOP_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(`${BASE_URL}/auth/shopify/callback`)}` +
    `&state=${estado}`;
  res.redirect(u);
});

app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOP_KEY, client_secret: SHOP_SECRET, code: req.query.code })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));
    writeJson(SHOP_TOKEN_FILE, j);
    res.send("Shopify conectada. Pode fechar esta aba.");
  } catch (e) { res.status(400).send("Falha ao conectar: " + e.message); }
});

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${SHOP_API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": shopifyToken() },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}
const ue = (o) => {
  const l = o?.userErrors || o?.mediaUserErrors || [];
  return l.length ? l.map(e => `${e.field || ""} ${e.message}`.trim()).join(" | ") : null;
};

/* ---------- Mercado Livre ---------- */
app.get("/auth/ml", (_, res) => res.redirect(
  `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`));

app.get("/auth/ml/callback", async (req, res) => {
  try {
    const r = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET,
        code: req.query.code, redirect_uri: ML_REDIRECT_URI
      })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));
    writeJson(TOKEN_FILE, { ...j, obtido_em: Date.now() });
    res.send("Mercado Livre conectado. Pode fechar esta aba.");
  } catch (e) { res.status(400).send("Falha ao conectar: " + e.message); }
});

async function mlToken() {
  let t = readJson(TOKEN_FILE, null);
  if (!t?.refresh_token && ML_REFRESH_SEED) t = { refresh_token: ML_REFRESH_SEED, obtido_em: 0, expires_in: 0 };
  if (!t?.refresh_token) throw new Error("Mercado Livre não conectado — preencha ML_REFRESH_TOKEN no .env ou abra /auth/ml");
  if (t.access_token && Date.now() - t.obtido_em < (t.expires_in - 600) * 1000) return t.access_token;
  const r = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET, refresh_token: t.refresh_token
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Refresh token do ML inválido ou já usado — abra /auth/ml e reconecte");
  writeJson(TOKEN_FILE, { ...j, obtido_em: Date.now() });
  return j.access_token;
}

async function mlApi(url, token, opts = {}) {
  const r = await fetch(url.startsWith("http") ? url : `https://api.mercadolibre.com${url}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) {
    const causa = (j.cause || []).map(c => c.message || c.code).join("; ");
    throw new Error([j.message, causa].filter(Boolean).join(" — ") || txt.slice(0, 300));
  }
  return j;
}

async function mlCategorias(token, texto) {
  const q = encodeURIComponent((texto || "").trim().slice(0, 120));
  let lista = [];
  try {
    lista = (await mlApi(`/sites/${ML_SITE}/domain_discovery/search?limit=5&q=${q}`, token))
      .map(x => ({ id: x.category_id, nome: x.category_name, dominio: x.domain_name }));
  } catch { }
  if (!lista.length) {
    try {
      const p = await mlApi(`/sites/${ML_SITE}/category_predictor/predict?title=${q}`, token);
      if (p?.id) lista = [{ id: p.id, nome: p.name, dominio: null }];
    } catch { }
  }
  return lista;
}

async function detalhesCategoria(token, id) {
  const attrs = await mlApi(`/categories/${id}/attributes`, token);
  const ignorar = new Set(["BRAND", "MODEL", "GTIN", "ITEM_CONDITION", "SELLER_SKU", "EMPTY_GTIN_REASON"]);
  const atributos = attrs
    .filter(a => {
      const t = a.tags || {};
      return (t.required || t.catalog_required || t.conditional_required) && !t.read_only && !ignorar.has(a.id);
    })
    .map(a => ({
      id: a.id, nome: a.name, tipo: a.value_type,
      obrigatorio: !!(a.tags?.required || a.tags?.catalog_required),
      valores: (a.values || []).slice(0, 80).map(v => ({ id: v.id, nome: v.name }))
    }));
  const cat = await mlApi(`/categories/${id}`, token);
  return { categoria: cat.name, caminho: (cat.path_from_root || []).map(c => c.name).join(" › "), atributos };
}

// categoriza sozinho a partir do título e já devolve a ficha da categoria
app.get("/api/ml/auto", async (req, res) => {
  try {
    const token = await mlToken();
    const lista = await mlCategorias(token, req.query.nome);
    if (!lista.length) throw new Error("não consegui identificar a categoria — descreva melhor o produto no título");
    const escolhida = lista[0];
    res.json({ ok: true, escolhida, alternativas: lista, ...(await detalhesCategoria(token, escolhida.id)) });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

app.get("/api/ml/categorias", async (req, res) => {
  try {
    const token = await mlToken();
    res.json({ ok: true, sugestoes: await mlCategorias(token, req.query.nome) });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

app.get("/api/ml/atributos", async (req, res) => {
  try {
    const token = await mlToken();
    res.json({ ok: true, ...(await detalhesCategoria(token, req.query.categoria)) });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

async function mlUploadFoto(url, token) {
  const { buf, tipo } = await baixarDrive(url.split("/").pop());
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: tipo }), "foto.jpg");
  const r = await fetch("https://api.mercadolibre.com/pictures/items/upload", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd
  });
  const j = await r.json();
  if (!j.id) throw new Error("upload de foto recusado pelo ML");
  return j.id;
}

/* ---------- ler EAN da foto da caixa ---------- */
app.post("/api/ler-ean", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) throw new Error("Sem ANTHROPIC_API_KEY — digite o EAN no campo");
    const ids = (req.body.fotos || []).slice(0, 4).map(u => u.split("/").pop());
    if (!ids.length) throw new Error("Selecione pelo menos a foto da caixa");
    const conteudo = [];
    for (const id of ids) {
      const { buf, tipo } = await baixarDrive(id);
      conteudo.push({
        type: "image",
        source: { type: "base64", media_type: tipo.includes("png") ? "image/png" : "image/jpeg", data: buf.toString("base64") }
      });
    }
    conteudo.push({
      type: "text",
      text: "Nestas fotos da caixa, ache o código de barras EAN/GTIN (12 a 14 dígitos impressos abaixo das barras). Responda APENAS os dígitos. Se não der para ler com certeza, responda NAO_ENCONTRADO."
    });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELO, max_tokens: 60, messages: [{ role: "user", content: conteudo }] })
    });
    const j = await r.json();
    const txt = (j.content || []).map(c => c.text || "").join("");
    const ean = (txt.match(/\d{12,14}/) || [])[0];
    if (!ean) throw new Error("Não consegui ler o código na foto — digite no campo");
    res.json({ ok: true, ean });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

/* ---------- descrição automática ---------- */
app.post("/api/gerar-texto", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) throw new Error("Sem ANTHROPIC_API_KEY — preencha os destaques na mão");
    const { titulo, categoria, ficha } = req.body;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Anúncio do canal Geek Antenado. Produto: ${titulo}. Categoria: ${categoria}.
Observações/ficha: ${ficha || "use seu conhecimento sobre este produto específico"}.
Escreva com base nas especificações técnicas reais desse produto (processador, tela, bateria, conectividade, material, capacidade etc. — o que for relevante pra categoria). Nada de texto genérico que serviria pra qualquer produto.
Responda SÓ com JSON, sem markdown:
{"intro":"1-2 frases descrevendo o produto e pra que serve, com algum dado técnico já na abertura","destaques":["6 a 9 bullets de especificações técnicas e diferenciais reais do produto, cada um específico e informativo"],"fechamento":"1 frase de pra quem é indicado, ligada a um uso real do produto","titulo_ml":"título Mercado Livre: tipo do produto primeiro, depois marca e modelo, máximo 60 caracteres"}`
        }]
      })
    });
    const j = await r.json();
    const txt = (j.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
    res.json({ ok: true, ...JSON.parse(txt) });
  } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
});

/* ---------- publicação com progresso ---------- */
const jobs = new Map();
function emitir(id, ev) {
  const j = jobs.get(id); if (!j) return;
  j.eventos.push(ev);
  j.clientes.forEach(c => c.write(`data: ${JSON.stringify(ev)}\n\n`));
}

app.get("/api/progresso/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders?.();
  j.eventos.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  if (j.fim) return res.end();
  j.clientes.push(res);
  req.on("close", () => { j.clientes = j.clientes.filter(c => c !== res); });
});

function montarDescricao(p) {
  const bl = (p.destaques || []).filter(Boolean);
  const html = [
    p.usado ? "<p>Produto usado para criação de vídeos no canal Geek Antenado.<br>Não possui marcas de uso.<br>Todos os acessórios na caixa.</p>" : "",
    p.intro ? `<p>${p.intro}</p>` : "",
    bl.length ? `<p><strong>✅ Especificações e destaques</strong></p>\n<ul>\n${bl.map(b => `<li>${b}</li>`).join("\n")}\n</ul>` : "",
    p.fechamento ? `<p>📌 ${p.fechamento}</p>` : ""
  ].filter(Boolean).join("\n");
  const texto = [
    p.usado ? "Produto usado para criação de vídeos no canal Geek Antenado.\nNão possui marcas de uso.\nTodos os acessórios na caixa." : "",
    p.intro, bl.length ? "Especificações e destaques:\n" + bl.map(b => `- ${b}`).join("\n") : "", p.fechamento
  ].filter(Boolean).join("\n\n");
  return { html, texto };
}

app.post("/api/publicar", (req, res) => {
  const id = crypto.randomUUID();
  jobs.set(id, { eventos: [], clientes: [], fim: false });
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
  res.json({ ok: true, job: id });
  const lista = Array.isArray(req.body.produtos) ? req.body.produtos : [req.body];
  publicarLote(id, lista).catch(e => {
    emitir(id, { tipo: "erro", texto: e.message });
    encerrar(id);
  });
});

function encerrar(id) {
  const j = jobs.get(id); if (j) { j.fim = true; j.clientes.forEach(c => c.end()); }
}

async function publicarLote(job, lista) {
  const ctx = {
    passo: 0,
    total: lista.reduce((a, b) => a + (b.shopify ? 4 : 0) + (b.ml ? 4 + (b.fotos || []).length : 0), 0) || 1
  };
  const resultados = [];
  for (const [i, b] of lista.entries()) {
    emitir(job, { tipo: "produto", indice: i + 1, total: lista.length, nome: (b.titulo || "").toUpperCase() });
    try { resultados.push(await publicarUm(job, b, ctx)); }
    catch (e) {
      emitir(job, { tipo: "falha", alvo: (b.titulo || "").toUpperCase(), texto: e.message });
      resultados.push({ produto: (b.titulo || "").toUpperCase(), erro: e.message });
    }
  }
  emitir(job, { tipo: "fim", pct: 100, resultados });
  encerrar(job);
}

async function publicarUm(job, b, ctx) {
  const calcPreco = (fixo, ref, desconto) => Number((fixo ? Number(fixo)
    : Number(ref || 0) * (1 - Number(desconto || 0) / 100)).toFixed(2)) || 0;
  // preço por plataforma: usa o campo específico se vier; senão cai no modo antigo (referência-desconto) pros dois
  const precoShopify = b.precoShopify != null ? Number(b.precoShopify) || 0 : calcPreco(b.precoFixo, b.precoRef, b.desconto);
  const precoML = b.precoML != null ? Number(b.precoML) || 0 : calcPreco(b.precoFixo, b.precoRef, b.desconto);
  const { html, texto } = montarDescricao(b);
  const fotos = b.fotos || [];
  const p = {
    titulo: (b.titulo || "").toUpperCase(),
    tituloML: (b.tituloML || b.titulo || "").slice(0, 60),
    marca: b.marca, modelo: b.modelo || b.titulo, categoria: b.categoria,
    sku: (b.sku || `${b.marca || ""}-${b.modelo || b.titulo || ""}`).toUpperCase().replace(/\s+/g, "-"),
    ean: (b.ean || "").replace(/\D/g, ""), estoque: Number(b.estoque || 1),
    precoShopify, precoML,
    precoDe: b.precoRef && !b.precoFixo ? Number(b.precoRef) : null,
    tags: b.tags || [], fotos, status: fotos.length ? "ACTIVE" : "DRAFT",
    descricaoHtml: html, descricaoTexto: texto
  };

  const passosShopify = 5;
  const etapa = (txt) => emitir(job, {
    tipo: "etapa", pct: Math.min(99, Math.round((++ctx.passo / ctx.total) * 100)), texto: txt
  });
  const out = { produto: p.titulo, precoShopify: p.precoShopify, precoML: p.precoML, sku: p.sku, shopify: null, ml: null, avisos: [] };

  if (b.shopify) {
    try {
      etapa("Criando produto na Shopify");
      const locationId = env.SHOPIFY_LOCATION_ID || (await gql(`{ locations(first:1){ nodes{ id } } }`)).locations.nodes[0]?.id;
      const d = await gql(`mutation s($input: ProductSetInput!){ productSet(synchronous:true, input:$input){
          product{ id } userErrors{ field message } } }`, {
        input: {
          title: p.titulo, descriptionHtml: p.descricaoHtml, productType: p.categoria, vendor: p.marca,
          tags: p.tags, status: p.status,
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [{
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price: String(p.precoShopify), ...(p.precoDe ? { compareAtPrice: String(p.precoDe) } : {}),
            sku: p.sku, ...(p.ean ? { barcode: p.ean } : {}),
            inventoryItem: { tracked: true },
            inventoryQuantities: [{ locationId, name: "available", quantity: p.estoque }]
          }]
        }
      });
      const err = ue(d.productSet); if (err) throw new Error(err);
      const pid = d.productSet.product.id;

      etapa(`Enviando ${fotos.length} foto(s) para a Shopify`);
      if (fotos.length) {
        const m = await gql(`mutation m($id:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$id, media:$media){
            mediaUserErrors{ field message } } }`,
          { id: pid, media: fotos.map(u => ({ originalSource: u, mediaContentType: "IMAGE" })) });
        const e2 = ue(m.productCreateMedia); if (e2) out.avisos.push("Fotos Shopify: " + e2);
      }

      etapa("Confirmando estoque rastreado");
      try {
        const chk = await gql(`query($id:ID!){ product(id:$id){ variants(first:1){ nodes{ inventoryItem{ id tracked } } } } }`, { id: pid });
        const item = chk.product?.variants?.nodes?.[0]?.inventoryItem;
        if (item && !item.tracked) {
          // productSet às vezes cria o item sem tracked de fato, mesmo pedindo — força de novo
          await gql(`mutation t($id:ID!,$input:InventoryItemInput!){ inventoryItemUpdate(id:$id, input:$input){ userErrors{ message } } }`,
            { id: item.id, input: { tracked: true } });
          out.avisos.push("Estoque não veio rastreado na primeira tentativa — corrigido.");
        }
      } catch (e) { out.avisos.push("Não consegui confirmar o rastreamento de estoque: " + e.message.slice(0, 120)); }

      etapa("Publicando na Loja Virtual");
      let publicado = true;
      try {
        const pub = await gql(`mutation p($id:ID!,$input:[PublicationInput!]!){ publishablePublish(id:$id,input:$input){
            userErrors{ field message } } }`, { id: pid, input: [{ publicationId: PUBLICATION_ID }] });
        if (ue(pub.publishablePublish)) publicado = false;
      } catch { publicado = false; }

      etapa("Shopify pronto");
      out.shopify = {
        ok: true, publicado, rascunho: p.status === "DRAFT",
        admin: `https://admin.shopify.com/store/${SHOP.replace(".myshopify.com", "")}/products/${pid.split("/").pop()}`
      };
    } catch (e) {
      ctx.passo += passosShopify;
      out.shopify = { ok: false, erro: e.message };
      emitir(job, { tipo: "falha", alvo: "Shopify", texto: e.message });
    }
  }

  if (b.ml) {
    try {
      if (!fotos.length) throw new Error("Sem fotos — o Mercado Livre exige ao menos uma imagem para Clássico");
      etapa("Autenticando no Mercado Livre");
      const token = await mlToken();

      etapa("Definindo categoria");
      let categoria = b.categoriaML;
      if (!categoria) {
        const sug = await mlCategorias(token, [p.tituloML, p.marca, p.modelo].filter(Boolean).join(" "));
        categoria = sug[0]?.id;
        if (categoria) out.avisos.push(`Categoria escolhida automaticamente: ${sug[0].nome} (${categoria})`);
      }
      if (!categoria) throw new Error("não consegui identificar a categoria — descreva melhor o produto no título");

      const pictures = [];
      for (const [i, url] of fotos.entries()) {
        etapa(`Enviando foto ${i + 1} de ${fotos.length} para o Mercado Livre`);
        try { pictures.push({ id: await mlUploadFoto(url, token) }); }
        catch (e) { out.avisos.push(`Foto ${i + 1} do ML: ${e.message}`); }
      }

      etapa("Criando anúncio no Mercado Livre");
      const attributes = [
        ...(p.marca ? [{ id: "BRAND", value_name: p.marca }] : []),
        ...(p.modelo ? [{ id: "MODEL", value_name: p.modelo }] : []),
        ...(p.ean ? [{ id: "GTIN", value_name: p.ean }] : []),
        ...(b.atributosML || []).filter(a => a.value_id || a.value_name)
      ];
      const corpo = {
        category_id: categoria, price: p.precoML, currency_id: "BRL",
        available_quantity: p.estoque, buying_mode: "buy_it_now", condition: "used",
        listing_type_id: "gold_special", pictures, attributes,
        shipping: { mode: "me2", local_pick_up: false, free_shipping: !!b.freteGratis },
        sale_terms: [
          { id: "WARRANTY_TYPE", value_name: b.garantiaTipo || "Garantia do vendedor" },
          { id: "WARRANTY_TIME", value_name: b.garantiaTempo || "30 dias" }
        ]
      };
      let item;
      try {
        item = await mlApi("/items", token, { method: "POST", body: JSON.stringify({ family_name: p.tituloML, ...corpo }) });
      } catch (e) {
        out.avisos.push("family_name recusado, usei title — " + e.message.slice(0, 140));
        item = await mlApi("/items", token, { method: "POST", body: JSON.stringify({ title: p.tituloML, ...corpo }) });
      }

      etapa("Publicando descrição");
      try {
        await mlApi(`/items/${item.id}/description`, token, { method: "POST", body: JSON.stringify({ plain_text: p.descricaoTexto }) });
      } catch (e) { out.avisos.push("Descrição do ML: " + e.message.slice(0, 140)); }

      etapa("Mercado Livre pronto");
      out.ml = { ok: true, id: item.id, url: item.permalink, status: item.status };
    } catch (e) {
      out.ml = { ok: false, erro: e.message };
      emitir(job, { tipo: "falha", alvo: "Mercado Livre", texto: e.message });
    }
  }

  const log = readJson(LOG_FILE, []);
  log.unshift({ data: new Date().toISOString(), ...out });
  writeJson(LOG_FILE, log.slice(0, 500));
  return out;
}

app.get("/api/historico", (_, res) => res.json(readJson(LOG_FILE, []).slice(0, 20)));
app.get("/api/status", async (_, res) => {
  const s = { shopify: false, drive: false, ia: !!ANTHROPIC_KEY, ml: false, pastaPadrao: DEFAULT_FOLDER, erros: {} };
  try { await gql(`{ shop { name } }`); s.shopify = true; }
  catch (e) { s.erros.shopify = e.message.slice(0, 160); s.shopifyConectar = !SHOP_STATIC_TOKEN; }
  try {
    if (!DRIVE_KEY) throw new Error("GOOGLE_API_KEY vazia");
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?pageSize=1&key=${DRIVE_KEY}` +
      `&q=${encodeURIComponent(`'${folderId(DEFAULT_FOLDER)}' in parents`)}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    s.drive = true;
  } catch (e) { s.erros.drive = e.message.slice(0, 160); }
  try { await mlToken(); s.ml = true; } catch (e) { s.erros.ml = e.message.slice(0, 160); }
  res.json(s);
});

app.listen(PORT, () => console.log(`anunciador em ${BASE_URL}`));
