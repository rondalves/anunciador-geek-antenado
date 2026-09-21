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
const GOOGLE_CLIENT_ID = env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GOOGLE_TOKEN_FILE = path.join(DATA, "google_token.json");
const DEFAULT_FOLDER = env.DRIVE_DEFAULT_FOLDER || "";

const ML_CLIENT_ID = env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = env.ML_REDIRECT_URI || `${BASE_URL}/auth/ml/callback`;
const ML_SITE = env.ML_SITE || "MLB";
const ML_REFRESH_SEED = env.ML_REFRESH_TOKEN || "";

const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || "";
const MODELO = env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const GEMINI_KEY = env.GEMINI_API_KEY || "";
// GEMINI_MODEL é só a PRIMEIRA tentativa. O Google aposenta modelo sem avisar —
// gemini-2.0-flash foi removido — então a lista abaixo segue adiante sozinha.
// Testados um a um nesta conta em 21/09/2026 com generateContent real.
const GEMINI_MODELOS = [...new Set([env.GEMINI_MODEL, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-latest"].filter(Boolean))];
let geminiModeloOk = ""; // último modelo que respondeu; aparece em /api/status

const TOKEN_FILE = path.join(DATA, "ml_token.json");
const LOG_FILE = path.join(DATA, "publicados.json");
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

/* ---------- senha ---------- */
app.use((req, res, next) => {
  if (!env.APP_PASSWORD || req.path.startsWith("/auth/ml") || req.path.startsWith("/auth/shopify") || req.path.startsWith("/auth/google") || req.path.startsWith("/img/")) return next();
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

app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).send("GOOGLE_OAUTH_CLIENT_ID não configurado no .env");
  const u = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(`${BASE_URL}/auth/google/callback`)}` +
    `&response_type=code&access_type=offline&prompt=consent` +
    `&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.readonly")}`;
  res.redirect(u);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: "authorization_code"
      })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));
    writeJson(GOOGLE_TOKEN_FILE, { ...j, obtido_em: Date.now() });
    res.send("Google Drive conectado. Pode fechar esta aba.");
  } catch (e) { res.status(400).send("Falha ao conectar: " + e.message); }
});

async function googleToken() {
  const t = readJson(GOOGLE_TOKEN_FILE, null);
  if (!t?.refresh_token) return null; // sem login feito — quem chamar cai pro modo com API key
  if (t.access_token && Date.now() - t.obtido_em < (t.expires_in - 300) * 1000) return t.access_token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token, grant_type: "refresh_token"
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Não consegui renovar o login do Google — abra /auth/google e reconecte");
  writeJson(GOOGLE_TOKEN_FILE, { ...t, ...j, obtido_em: Date.now() }); // Google não reenvia refresh_token toda vez — mantém o antigo
  return j.access_token;
}

const baixarDrive = async (id, tentativa = 1) => {
  const tokenGoogle = await googleToken().catch(() => null);
  const url = tokenGoogle
    ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${DRIVE_KEY}`;
  const r = await fetch(url, tokenGoogle ? { headers: { Authorization: `Bearer ${tokenGoogle}` } } : {});
  if (!r.ok) {
    // pode ser instabilidade passageira (rede/cota) — tenta mais uma vez antes de desistir
    if (tentativa === 1) { await new Promise(res => setTimeout(res, 800)); return baixarDrive(id, 2); }
    const corpo = await r.text().catch(() => "");
    let motivo = corpo;
    try { motivo = JSON.parse(corpo)?.error?.message || corpo; } catch { /* mantém texto cru */ }
    const dica = r.status === 403
      ? (tokenGoogle ? " — confira se sua conta do Google tem acesso a essa pasta" : " — conecte o Google em /auth/google para baixar com login em vez de chave de API")
      : "";
    throw new Error(`Drive recusou o arquivo ${id} (HTTP ${r.status}): ${motivo.slice(0, 200) || "sem detalhes"}${dica}`);
  }
  return { buf: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get("content-type") || "image/jpeg" };
};

app.get("/img/:id", async (req, res) => {
  try {
    const { buf, tipo } = await baixarDrive(req.params.id);
    res.set({ "Content-Type": tipo, "Cache-Control": "public, max-age=86400" }).send(buf);
  } catch (e) { res.status(404).send("imagem nao encontrada: " + e.message); }
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

let renovandoML = null; // trava: evita duas renovações simultâneas gastarem o mesmo refresh_token

async function mlToken() {
  let t = readJson(TOKEN_FILE, null);
  if (!t?.refresh_token && ML_REFRESH_SEED) t = { refresh_token: ML_REFRESH_SEED, obtido_em: 0, expires_in: 0 };
  if (!t?.refresh_token) throw new Error("Mercado Livre não conectado — preencha ML_REFRESH_TOKEN no .env ou abra /auth/ml");
  if (t.access_token && Date.now() - t.obtido_em < (t.expires_in - 600) * 1000) return t.access_token;

  // já tem uma renovação em andamento (outra publicação/aba pediu ao mesmo tempo) — espera ela e reaproveita
  if (renovandoML) return renovandoML;

  renovandoML = (async () => {
    try {
      const r = await fetch("https://api.mercadolibre.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token", client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET, refresh_token: t.refresh_token
        })
      });
      const j = await r.json();
      if (j.access_token) { writeJson(TOKEN_FILE, { ...j, obtido_em: Date.now() }); return j.access_token; }

      // refresh_token recusado — pode ser que OUTRA renovação, concorrente, já tenha girado ele antes desta.
      // Relê o arquivo: se alguém já salvou um token mais novo enquanto esperávamos, usa esse em vez de falhar.
      const atual = readJson(TOKEN_FILE, null);
      if (atual?.access_token && atual.refresh_token !== t.refresh_token) return atual.access_token;

      throw new Error("Refresh token do ML inválido ou já usado — abra /auth/ml e reconecte");
    } finally { renovandoML = null; }
  })();

  return renovandoML;
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
  // 2ª via: em que categoria estão os anúncios reais desse produto.
  // O antigo /category_predictor/predict foi removido pelo ML (404) — não adianta chamar.
  if (!lista.length) {
    try {
      const r = await mlApi(`/sites/${ML_SITE}/search?limit=20&q=${q}`, token);
      const conta = new Map();
      for (const it of r.results || []) if (it.category_id) conta.set(it.category_id, (conta.get(it.category_id) || 0) + 1);
      for (const [id] of [...conta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        const c = await mlApi(`/categories/${id}`, token).catch(() => null);
        if (c) lista.push({ id, nome: c.name, dominio: null });
      }
    } catch { }
  }
  return lista;
}

// o ML só aceita anúncio em categoria FOLHA que permita publicar — categoria de galho é recusada
async function validarCategoria(token, id, texto) {
  const folhaOk = async (cid) => {
    if (!cid) return null;
    try {
      const c = await mlApi(`/categories/${cid}`, token);
      if ((c.children_categories || []).length) return null;
      if (c.settings?.listing_allowed === false) return null;
      return { id: cid, nome: c.name };
    } catch { return null; }
  };
  const escolhida = await folhaOk(id);
  if (escolhida) return escolhida;
  for (const s of await mlCategorias(token, texto)) {
    const c = await folhaOk(s.id);
    if (c) return c;
  }
  return null;
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

// pede pra IA preencher os atributos obrigatórios da categoria que o formulário simplificado não coleta
// (cada categoria do ML pede coisas diferentes — voltagem, cor, linha etc. — sem isso a publicação é recusada)
// fala com a IA disponível: Gemini primeiro (gratuito, com busca no Google embutida),
// Anthropic como alternativa só se GEMINI_API_KEY não estiver configurada
// modelo aposentado (404) ou sobrecarregado (503/429): o próximo da lista costuma atender.
// erro de chave ou de prompt não melhora trocando de modelo — nesses não adianta insistir.
const MODELO_SUMIU = /not found|no longer available|not supported|unsupported|does not exist|deprecated/i;
const MODELO_LOTADO = /high demand|overloaded|try again later|rate limit|quota|resource has been exhausted|unavailable/i;
const trocarDeModelo = (status, msg) =>
  status === 404 || status === 429 || status === 500 || status === 503 ||
  MODELO_SUMIU.test(msg) || MODELO_LOTADO.test(msg);

// no tier gratuito o 429 é por minuto e o próprio Google diz quanto esperar
const esperaSugerida = (erro) => {
  for (const d of erro?.details || []) {
    const s = parseFloat(String(d.retryDelay || "").replace("s", ""));
    if (s > 0) return Math.min(s + 1, 45) * 1000; // teto de 45s: acima disso a publicação trava demais
  }
  return 0;
};

async function chamarGemini(prompt) {
  let ultimoErro = "";
  for (let volta = 0; volta < 3; volta++) {
    let esperar = 0;
    for (const modelo of GEMINI_MODELOS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
      });
      const j = await r.json().catch(() => ({}));
      if (!j.error) {
        if (geminiModeloOk !== modelo) console.log(`[IA] Gemini respondendo pelo modelo ${modelo}`);
        geminiModeloOk = modelo;
        return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
      }
      ultimoErro = j.error.message || `HTTP ${r.status}`;
      if (!trocarDeModelo(r.status, ultimoErro)) throw new Error(ultimoErro); // chave/prompt: trocar não resolve
      if (MODELO_LOTADO.test(ultimoErro)) esperar = Math.max(esperar, esperaSugerida(j.error) || 10000);
      console.warn(`[IA] modelo ${modelo} indisponível (${ultimoErro.slice(0, 120)}) — tentando o próximo`);
    }
    if (!esperar) break; // todos aposentados de vez: repetir não muda nada
    console.warn(`[IA] todos os modelos lotados — esperando ${Math.round(esperar / 1000)}s antes de tentar de novo`);
    await new Promise(r => setTimeout(r, esperar));
  }
  throw new Error(ultimoErro);
}

async function chamarAnthropic(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODELO, max_tokens: 1800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }]
    })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "erro na API da Anthropic");
  return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
}

async function chamarIA(prompt) {
  let erroGemini = "";
  if (GEMINI_KEY) {
    try { return await chamarGemini(prompt); }
    catch (e) { erroGemini = e.message; console.warn("[IA] Gemini falhou:", erroGemini.slice(0, 200)); }
  }
  if (ANTHROPIC_KEY) {
    try { return await chamarAnthropic(prompt); }
    catch (e) {
      // sem os dois lados o aviso na tela não diz nada útil sobre por que a IA não respondeu
      throw new Error(erroGemini
        ? `Gemini: ${erroGemini.slice(0, 200)} || Anthropic: ${e.message.slice(0, 200)}`
        : e.message);
    }
  }
  if (erroGemini) throw new Error("Gemini: " + erroGemini);
  throw new Error("Nenhuma IA configurada — preencha GEMINI_API_KEY (grátis) no .env");
}

function extrairJSON(texto) {
  const entre = texto.match(/===INICIO_JSON===([\s\S]*?)===FIM_JSON===/);
  const bruto = entre ? entre[1] : (texto.match(/\{[\s\S]*\}/) || [])[0];
  if (!bruto) throw new Error("A IA não devolveu texto reconhecível — resposta: " + texto.slice(0, 200));
  try { return JSON.parse(bruto.trim()); }
  catch { throw new Error("JSON da IA veio malformado: " + bruto.slice(0, 200)); }
}

async function preencherAtributosComIA(tituloML, marca, modelo, atributos) {
  const faltando = atributos.filter(a => a.obrigatorio);
  if (!faltando.length || (!GEMINI_KEY && !ANTHROPIC_KEY)) return [];
  const lista = faltando.map(a => ({
    id: a.id, nome: a.nome,
    valores: a.valores.length ? a.valores.map(v => `${v.id}="${v.nome}"`).join(", ") : "(texto livre)"
  }));
  const prompt = `Produto: ${tituloML}. Marca: ${marca}. Modelo: ${modelo}.
Preencha estes atributos obrigatórios do Mercado Livre com o valor mais provável pra este produto específico:
${lista.map(a => `- ${a.nome} (id ${a.id}): opções [${a.valores}]`).join("\n")}
Se o atributo tiver opções de id listadas, responda com o id exato de uma delas. Se for texto livre, escreva um valor curto plausível.
Responda SÓ com JSON entre ===INICIO_JSON=== e ===FIM_JSON===, no formato {"ID_DO_ATRIBUTO":"valor_ou_id"} para cada atributo acima.`;
  try {
    const valores = extrairJSON(await chamarIA(prompt));
    const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    return faltando.map(a => {
      const v = valores[a.id]; if (!v) return null;
      // a IA às vezes devolve o nome ("127/220V") em vez do id — aceita os dois
      const bate = a.valores.find(x => x.id === v)
        || a.valores.find(x => norm(x.nome) === norm(v))
        || a.valores.find(x => norm(x.nome).includes(norm(v)) || norm(v).includes(norm(x.nome)));
      if (bate) return { id: a.id, value_id: bate.id, value_name: bate.nome };
      // se a categoria tem lista fechada e nada bateu, mandar texto livre é recusa certa
      return a.valores.length ? null : { id: a.id, value_name: String(v) };
    }).filter(Boolean);
  } catch (e) {
    // deixa subir: engolir aqui fazia a publicação morrer depois com "[VOLTAGE] required"
    // sem dizer que a causa foi a IA não ter respondido
    throw new Error(`IA não preencheu ${faltando.map(a => a.id).join(", ")} — ${e.message}`);
  }
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
    const { titulo, categoria, ficha } = req.body;
    const prompt = `Anúncio do canal Geek Antenado. Produto: ${titulo}. Categoria: ${categoria}.
Observações/ficha: ${ficha || "nenhuma"}.
Pesquise na internet a ficha técnica real desse produto específico (processador, tela, bateria, câmera, conectividade, material, capacidade — o que for relevante pra categoria) antes de escrever. Nada de texto genérico que serviria pra qualquer produto da categoria.
Depois de pesquisar, escreva a resposta final. Envolva o JSON final, e SÓ ele, entre as marcas ===INICIO_JSON=== e ===FIM_JSON=== — sem markdown, sem \`\`\` dentro das marcas:
===INICIO_JSON===
{"intro":"1-2 frases descrevendo o produto e pra que serve, com algum dado técnico real já na abertura","destaques":["6 a 9 bullets de especificações técnicas reais e diferenciais do produto, cada um específico e verificado na pesquisa"],"fechamento":"1 frase de pra quem é indicado, ligada a um uso real do produto","titulo_ml":"título Mercado Livre: tipo do produto primeiro, depois marca e modelo, máximo 60 caracteres"}
===FIM_JSON===`;
    const dados = extrairJSON(await chamarIA(prompt));
    res.json({ ok: true, ...dados });
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
    total: lista.reduce((a, b) => a + (b.shopify ? 5 : 0) + (b.ml ? 5 + (b.fotos || []).length : 0), 0) || 1
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
      const cat = await validarCategoria(token, b.categoriaML, [p.tituloML, p.marca, p.modelo].filter(Boolean).join(" "));
      if (!cat) throw new Error("não consegui identificar uma categoria válida do ML — descreva melhor o produto no título");
      const categoria = cat.id;
      if (categoria !== b.categoriaML) out.avisos.push(`Categoria escolhida automaticamente: ${cat.nome} (${categoria})`);

      etapa("Conferindo atributos obrigatórios da categoria");
      let atributosIA = [];
      try {
        const det = await detalhesCategoria(token, categoria);
        atributosIA = await preencherAtributosComIA(p.tituloML, p.marca, p.modelo, det.atributos);
        if (atributosIA.length) out.avisos.push(`Atributos preenchidos automaticamente: ${atributosIA.map(a => a.id).join(", ")} (modelo ${geminiModeloOk || MODELO})`);
      } catch (e) { out.avisos.push("Atributos da categoria: " + e.message.slice(0, 300)); }

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
        ...atributosIA,
        ...(b.atributosML || []).filter(a => a.value_id || a.value_name)
      ];
      const corpo = {
        category_id: categoria, price: p.precoML, currency_id: "BRL",
        available_quantity: p.estoque, buying_mode: "buy_it_now",
        condition: b.usado === false ? "new" : "used", // o checkbox do painel era coletado e ignorado aqui
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
  const s = { shopify: false, drive: false, ia: !!(GEMINI_KEY || ANTHROPIC_KEY), iaProvedor: GEMINI_KEY ? `Gemini (${geminiModeloOk || GEMINI_MODELOS[0]})` : (ANTHROPIC_KEY ? `Anthropic (${MODELO})` : null), ml: false, pastaPadrao: DEFAULT_FOLDER, erros: {} };
  s.diagnostico = {
    arquivoTokenML: fs.existsSync(TOKEN_FILE),
    arquivoTokenShopify: fs.existsSync(SHOP_TOKEN_FILE),
    pastaDataGravavel: (() => { try { fs.accessSync(DATA, fs.constants.W_OK); return true; } catch { return false; } })()
  };
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
  s.driveComLogin = !!readJson(GOOGLE_TOKEN_FILE, null)?.refresh_token;
  s.driveConectar = !s.driveComLogin && !!GOOGLE_CLIENT_ID;
  try {
    await mlToken();
    s.ml = true;
    const t = readJson(TOKEN_FILE, null);
    if (t) s.diagnostico.mlTokenObtidoEm = new Date(t.obtido_em).toISOString();
  } catch (e) { s.erros.ml = e.message.slice(0, 160); }
  res.json(s);
});

app.listen(PORT, () => console.log(`anunciador em ${BASE_URL}`));
// expostos para scripts/teste-ml.mjs — nao muda o comportamento do app
export { validarCategoria, detalhesCategoria, preencherAtributosComIA, chamarIA, extrairJSON };
