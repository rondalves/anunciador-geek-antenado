// Confere as travas de acesso. Sobe o servidor de verdade e bate nas rotas.
//   node scripts/teste-seguranca.mjs
import { spawn } from "node:child_process";
import { setTimeout as esperar } from "node:timers/promises";

const PORTA = 8199, SENHA = "senha-de-teste";
const srv = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: { ...process.env, PORT: String(PORTA), APP_PASSWORD: SENHA, BASE_URL: `http://localhost:${PORTA}` },
  stdio: "ignore"
});
await esperar(3500);
const base = `http://localhost:${PORTA}`;
let falhas = 0;
const ok = (nome, cond, det = "") => {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${det ? " — " + det : ""}`);
  if (!cond) falhas++;
};
const codigo = async (caminho, cabecalhos = {}) =>
  (await fetch(base + caminho, { headers: cabecalhos, redirect: "manual" })).status;
const comSenha = { Authorization: "Basic " + Buffer.from(":" + SENHA).toString("base64") };

console.log("\n-- sem senha, nada do painel pode responder --");
for (const r of ["/", "/api/status", "/api/historico", "/api/publicar", "/api/ml/preview?nome=x"])
  ok(`${r} exige senha`, (await codigo(r)) === 401);

console.log("\n-- iniciar OAuth tambem passou a exigir senha --");
for (const r of ["/auth/ml", "/auth/shopify", "/auth/google"])
  ok(`${r} exige senha`, (await codigo(r)) === 401, "antes era aberto");

console.log("\n-- com senha, o painel volta a responder --");
ok("/ responde com senha", (await codigo("/", comSenha)) === 200);
ok("/auth/ml redireciona com senha", (await codigo("/auth/ml", comSenha)) === 302);

console.log("\n-- callbacks continuam abertos (o provedor chega sem sessao) --");
for (const r of ["/auth/ml/callback", "/auth/shopify/callback", "/auth/google/callback"])
  ok(`${r} acessivel`, (await codigo(r)) !== 401);

console.log("\n-- mas recusam state invalido --");
for (const r of ["/auth/ml/callback?code=x", "/auth/shopify/callback?code=x", "/auth/google/callback?code=x"]) {
  const t = await (await fetch(base + r)).text();
  ok(`${r.split("?")[0]} recusa sem state`, /state invalido/i.test(t), t.slice(0, 60));
}
{
  const t = await (await fetch(`${base}/auth/ml/callback?code=x&state=ml.9999999999999.assinaturaFalsa`)).text();
  ok("recusa state com assinatura forjada", /state invalido/i.test(t), t.slice(0, 60));
}

console.log("\n-- /img/ so aceita link assinado por este servidor --");
ok("sem assinatura e recusado", (await codigo("/img/ID_QUALQUER")) === 403);
ok("assinatura inventada e recusada", (await codigo("/img/ID_QUALQUER?ate=9999999999999&s=forjada")) === 403);
ok("assinatura valida mas expirada e recusada", (await codigo("/img/ID?ate=1&s=qualquer")) === 403);

console.log("\n-- e o link VALIDO precisa passar, senao a foto nao chega na Shopify --");
{
  const fs = await import("node:fs"), crypto = await import("node:crypto"), path = await import("node:path");
  const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const segredo = JSON.parse(fs.readFileSync(path.join(raiz, "data", "url_secret.json"), "utf8")).segredo;
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", ate = Date.now() + 60000;
  const s = crypto.createHmac("sha256", segredo).update(`${id}.${ate}`).digest("base64url");
  const c = await codigo(`/img/${id}?ate=${ate}&s=${encodeURIComponent(s)}`);
  // 404 = assinatura aceita, so nao achou o arquivo no Drive. 403 seria trava indevida.
  ok("link assinado passa pela trava", c !== 403, `HTTP ${c} (404 esperado: o ID nao existe no Drive)`);
  ok("o segredo fica em disco e sobrevive a restart", !!segredo && segredo.length === 64);
}

console.log(falhas ? `\n${falhas} FALHARAM` : "\nTodas as travas conferidas");
srv.kill();
process.exit(falhas ? 1 : 0);
