// Testa UMA A UMA as mudancas que eu adicionei, sem depender de IA nem de token do ML.
//   node scripts/teste-adicoes.mjs
process.env.PORT = process.env.PORT || "0";
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const m = await import("../server.js");
let falhas = 0;
const ok = (nome, cond, det = "") => {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${det ? " — " + det : ""}`);
  if (!cond) falhas++;
};
const T = "TOKEN_PUBLICO";

console.log("\n-- 1. cascata de modelos do Gemini (trocarDeModelo) --");
ok("404 troca de modelo", m.trocarDeModelo(404, "not found"));
ok("429 de cota troca de modelo", m.trocarDeModelo(429, "You exceeded your current quota"));
ok("503 de sobrecarga troca de modelo", m.trocarDeModelo(503, "high demand"));
ok("'no longer available' troca de modelo", m.trocarDeModelo(400, "This model is no longer available"));
ok("chave invalida NAO troca de modelo", !m.trocarDeModelo(400, "API key not valid"));
ok("prompt bloqueado NAO troca de modelo", !m.trocarDeModelo(400, "blocked by safety settings"));

console.log("\n-- 2. respeitar o retryDelay que o Google manda (esperaSugerida) --");
ok("le retryDelay de 9.8s", m.esperaSugerida({ details: [{ retryDelay: "9.888s" }] }) === 10888,
  String(m.esperaSugerida({ details: [{ retryDelay: "9.888s" }] })));
ok("teto de 45s em delay absurdo", m.esperaSugerida({ details: [{ retryDelay: "600s" }] }) === 45000);
ok("sem retryDelay devolve 0", m.esperaSugerida({ details: [] }) === 0);
ok("erro sem details nao quebra", m.esperaSugerida({}) === 0);
ok("erro undefined nao quebra", m.esperaSugerida(undefined) === 0);

console.log("\n-- 3. checksum de GTIN (gtinValido) --");
ok("EAN-13 valido", m.gtinValido("7891000053508"));
ok("EAN-13 com digito errado", !m.gtinValido("7891000053509"));
ok("UPC-A 12 digitos", m.gtinValido("036000291452"));
ok("EAN-8 valido", m.gtinValido("96385074"));
ok("aceita com traco", m.gtinValido("789-1000-053508"));
ok("11 digitos e recusado", !m.gtinValido("12345678901"));
ok("null nao quebra", !m.gtinValido(null));

console.log("\n-- 4. formato por value_type (comoEnviar) --");
const A = (id, tipo) => ({ id, tipo, valores: [] });
const v = { id: "77", nome: "8 GB" };
ok("string com lista -> value_id", m.comoEnviar(A("COLOR", "string"), v).value_id === "77");
ok("list -> value_id", m.comoEnviar(A("CARRIER", "list"), v).value_id === "77");
ok("number_unit -> so value_name", (() => { const r = m.comoEnviar(A("RAM", "number_unit"), v); return r.value_name === "8 GB" && r.value_id === undefined; })());
ok("boolean -> so value_name", (() => { const r = m.comoEnviar(A("IS_DUAL_SIM", "boolean"), { id: "1", nome: "Sim" }); return r.value_name === "Sim" && r.value_id === undefined; })());

console.log("\n-- 4b. Anatel so com digitos (limparAtributo) --");
ok("tira os tracos da homologacao",
  m.limparAtributo({ id: "CELLPHONES_ANATEL_HOMOLOGATION_NUMBER", value_name: "01657-26-13366" }).value_name === "016572613366");
ok("vale tambem pro ANATEL_HOMOLOGATION_NUMBER",
  m.limparAtributo({ id: "ANATEL_HOMOLOGATION_NUMBER", value_name: "0165-7" }).value_name === "01657");
ok("nao mexe em outro atributo",
  m.limparAtributo({ id: "MODEL", value_name: "RG35XX-H" }).value_name === "RG35XX-H");
ok("nao mexe em value_id",
  m.limparAtributo({ id: "VOLTAGE", value_id: "39205163" }).value_id === "39205163");

console.log("\n-- 5. categoria folha (validarCategoria) --");
ok("folha valida e mantida", (await m.validarCategoria(T, "MLB11172", "x"))?.id === "MLB11172");
ok("galho e recusado", (await m.validarCategoria(T, "MLB1000", "x"))?.id !== "MLB1000");
ok("id inexistente devolve null e nao lanca", (await m.validarCategoria(T, "MLB_XX", "")) === null);

console.log("\n-- 6. predictor morto foi mesmo removido --");
const src = await (await import("node:fs")).promises.readFile(new URL("../server.js", import.meta.url), "utf8");
// so vale como chamada de verdade: linha de comentario nao conta
const semComentarios = src.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
ok("nao chama mais /category_predictor (404 na API)", !semComentarios.includes("category_predictor"));
ok("usa /sites/<site>/search no lugar", src.includes("/search?limit=20"));

console.log("\n-- 7. sinonimos e padrao de atributo --");
const det = await m.detalhesCategoria(T, "MLB11172");
const volt = det.atributos.find(a => a.id === "VOLTAGE");
for (const [txt, esperado] of [["bivolt", "127/220V"], ["100-240v", "127/220V"], ["110v", "127V"],
                               ["127/220V", "127/220V"], ["220V", "220V"], ["127v", "127V"]]) {
  ok(`"${txt}" -> ${esperado}`, m.valorPorTexto(volt, "produto " + txt)?.nome === esperado,
    m.valorPorTexto(volt, "produto " + txt)?.nome);
}
ok("texto sem voltagem nao inventa", m.valorPorTexto(volt, "console 64gb retro") === null);
ok("padrao e bivolt", m.valorPadrao(volt)?.nome === "127/220V");
ok("atributo sem padrao conhecido devolve null", m.valorPadrao({ id: "COLOR", valores: [{ id: "1", nome: "Preto" }] }) === null);

console.log("\n-- 8. cascata de resolucao (resolverAtributos) --");
const prod = { titulo: "Anbernic RG35XX H 64GB", tituloML: "Anbernic RG35XX H", descricaoTexto: "" };
const r1 = await m.resolverAtributos(T, "MLB11172", prod, []);
ok("sem IA resolve VOLTAGE", !!r1.resolvidos.find(a => a.id === "VOLTAGE"));
ok("value_id existe na lista real do ML",
  volt.valores.some(x => x.id === r1.resolvidos.find(a => a.id === "VOLTAGE")?.value_id));
ok("nada fica faltando", r1.faltam.length === 0);
ok("origem e 'padrao'", r1.origem.join() === "VOLTAGE=padrão", r1.origem.join());

const r2 = await m.resolverAtributos(T, "MLB11172", { ...prod, tituloML: "Anbernic 220V" }, []);
ok("titulo vence o padrao", r2.resolvidos.find(a => a.id === "VOLTAGE")?.value_name === "220V");
ok("origem vira 'titulo'", r2.origem.join() === "VOLTAGE=título", r2.origem.join());

const r3 = await m.resolverAtributos(T, "MLB11172", prod, [{ id: "VOLTAGE", value_id: "x" }]);
ok("formulario nao e sobrescrito", r3.resolvidos.length === 0);

const r4 = await m.resolverAtributos(T, "MLB438563", prod, []);
ok("categoria sem obrigatorios nao trava", r4.faltam.length === 0 && r4.resolvidos.length === 0);

const r5 = await m.resolverAtributos(T, "MLB1055", prod, []);
ok("categoria impossivel lista o que falta", r5.faltam.length >= 5, r5.faltam.map(a => a.nome).join(", "));

const r6 = await m.resolverAtributos(T, "MLB11172", prod, [], { semIA: true });
ok("semIA nao impede a resolucao", !!r6.resolvidos.find(a => a.id === "VOLTAGE"));
ok("semIA nao reporta erro de IA", r6.erroIA === "");

console.log("\n-- 9. publicacao repetivel (idempotencia por SKU) --");
// sem credencial de Shopify/ML as buscas falham: o contrato e devolver null e nunca
// lancar, senao uma busca fora do ar impediria a publicacao inteira
ok("produtoPorSku sem credencial devolve null", (await m.produtoPorSku("QUALQUER-SKU")) === null);
ok("produtoPorSku com sku vazio devolve null", (await m.produtoPorSku("")) === null);
ok("anuncioPorSku sem credencial devolve null", (await m.anuncioPorSku(T, "QUALQUER-SKU")) === null);
ok("anuncioPorSku com sku vazio devolve null", (await m.anuncioPorSku(T, "")) === null);
ok("Shopify reusa o id quando o SKU ja existe", src.includes("jaExiste ? { id: jaExiste }"));
ok("nao reenvia fotos em produto reaproveitado", src.includes("já tinha fotos na Shopify"));
ok("ML sinaliza anuncio existente em vez de criar outro", src.includes("JA_ANUNCIADO"));
ok("anuncio que ja existia conta como sucesso", src.includes('status: "já existia"'));

console.log("\n-- 10. descricao sem IA, a partir do titulo --");
const tAnbernic = "VIDEO GAME PORTATIL RETRÔ ANBERNIC RG35XX H TELA IPS 3.5 DUPLO ANALOGICO WI-FI BLUETOOTH HDMI 64GB";
const fAnbernic = m.fichaDoTitulo(tAnbernic);
ok("extrai 8 especificacoes do titulo real", fAnbernic.length === 8, fAnbernic.length + ": " + fAnbernic.join(" | "));
ok("pega Wi-Fi com hifen", fAnbernic.includes("Conexão Wi-Fi"));
ok("pega armazenamento", fAnbernic.includes("64GB de armazenamento"));
ok("pega polegadas da tela", fAnbernic.includes("Tela de 3.5 polegadas"));
ok("nao confunde 'HDMI 2.1' com tamanho de tela",
  !m.fichaDoTitulo("Cabo HDMI 2.1 de 2 metros").some(x => x.includes("polegadas")),
  m.fichaDoTitulo("Cabo HDMI 2.1 de 2 metros").join(" | "));
ok("mantem as duas casas decimais (1.43)",
  m.fichaDoTitulo("Smartwatch Tela AMOLED 1.43 GPS").includes("Tela de 1.43 polegadas"));
ok("bateria em mAh", m.fichaDoTitulo("Celular Bateria 5110mAh").includes("Bateria de 5110 mAh"));
ok("titulo sem especificacao nao inventa nada", m.fichaDoTitulo("Produto Generico").length === 0);

const desc = m.montarDescricao({ titulo: tAnbernic, usado: true, destaques: [] });
ok("descricao final tem lista de destaques", /<ul>/.test(desc.html));
ok("texto do ML tem as especificacoes", desc.texto.includes("Saída HDMI"));
ok("mantem a frase padrao do canal", desc.texto.includes("Geek Antenado"));
ok("intro usa o titulo inteiro, nao o corte marca/modelo", desc.texto.includes(tAnbernic));
// se a IA respondeu, o que ela escreveu tem que prevalecer
const comIA = m.montarDescricao({ titulo: tAnbernic, usado: true, destaques: ["Bullet da IA"], intro: "Intro da IA" });
ok("destaques da IA nao sao sobrescritos", comIA.texto.includes("Bullet da IA") && !comIA.texto.includes("Saída HDMI"));

console.log(falhas ? `\n${falhas} FALHARAM` : "\nTodas as adicoes conferidas");
process.exit(falhas ? 1 : 0);
