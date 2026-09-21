// Confere, contra as APIs reais, o que costuma quebrar a publicacao no Mercado Livre.
// Rode antes de subir pra VPS:  node --env-file=.env scripts/teste-ml.mjs
// Nao precisa de credencial do ML: /categories/* e publico. A parte de IA usa a GEMINI_API_KEY
// e aparece como PULADO se a cota do tier gratuito estiver esgotada no momento.
process.env.PORT = process.env.PORT || "0"; // importar o server.js sobe o listen

const { validarCategoria, detalhesCategoria, chamarIA, extrairJSON } = await import("../server.js");

const CAT = "MLB11172";          // Consoles — exige VOLTAGE
const TOKEN = "TOKEN_PUBLICO";   // endpoints de categoria do ML dispensam auth
let falhas = 0;
const ok = (nome, cond, detalhe = "") => {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${detalhe ? " — " + detalhe : ""}`);
  if (!cond) falhas++;
};

const folha = await validarCategoria(TOKEN, CAT, "Console Sony PlayStation 5 Slim");
ok("categoria folha valida e mantida", folha?.id === CAT, JSON.stringify(folha));

const galho = await validarCategoria(TOKEN, "MLB1000", "Console Sony PlayStation 5 Slim");
ok("categoria de galho e recusada", galho?.id !== "MLB1000", JSON.stringify(galho));

const det = await detalhesCategoria(TOKEN, CAT);
ok("VOLTAGE aparece como obrigatorio", det.atributos.some(a => a.id === "VOLTAGE" && a.obrigatorio),
  det.atributos.map(a => `${a.id}${a.obrigatorio ? "*" : ""}`).join(", "));

// a IA tem que escolher um dos valores fechados da categoria, nao inventar texto
const faltando = det.atributos.filter(a => a.obrigatorio);
const prompt = `Produto: Console Sony PlayStation 5 Slim 1TB. Marca: Sony. Modelo: PlayStation 5 Slim.
Preencha estes atributos obrigatórios do Mercado Livre:
${faltando.map(a => `- ${a.nome} (id ${a.id}): opções [${a.valores.map(v => `${v.id}="${v.nome}"`).join(", ")}]`).join("\n")}
Responda SÓ com JSON entre ===INICIO_JSON=== e ===FIM_JSON===, no formato {"ID_DO_ATRIBUTO":"valor_ou_id"}.`;
try {
  const valores = extrairJSON(await chamarIA(prompt));
  const v = valores.VOLTAGE;
  const bate = det.atributos.find(a => a.id === "VOLTAGE").valores.some(x => x.id === v || x.nome === v);
  ok("IA devolve VOLTAGE valido da lista do ML", bate, JSON.stringify(v));
} catch (e) {
  const cota = /quota|high demand|rate limit|unavailable/i.test(e.message);
  console.log(cota
    ? "PULADO  IA sem cota agora — o codigo esta ok, teste de novo mais tarde ou na VPS"
    : `FALHOU  IA — ${e.message.slice(0, 200)}`);
  if (!cota) falhas++;
}

console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTudo que da pra testar aqui passou");
process.exit(falhas ? 1 : 0);
