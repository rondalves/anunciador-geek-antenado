// Confere, contra as APIs reais do Mercado Livre, tudo que costuma barrar a publicacao.
// Roda SEM chave de IA de proposito: o caminho critico nao pode depender do Gemini.
//   node scripts/teste-ml.mjs
process.env.PORT = process.env.PORT || "0";
delete process.env.GEMINI_API_KEY;      // forca o cenario "IA fora do ar"
delete process.env.ANTHROPIC_API_KEY;

const { validarCategoria, detalhesCategoria, resolverAtributos, valorPorTexto, valorPadrao, gtinValido, comoEnviar }
  = await import("../server.js");

const T = "TOKEN_PUBLICO"; // /categories/* do ML dispensa auth
let falhas = 0;
const ok = (nome, cond, detalhe = "") => {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${detalhe ? " — " + detalhe : ""}`);
  if (!cond) falhas++;
};
const temValor = (attrs, id) => attrs.find(a => a.id === id);

/* ---------- categoria ---------- */
const folha = await validarCategoria(T, "MLB11172", "Console PlayStation 5");
ok("categoria folha valida e mantida", folha?.id === "MLB11172", JSON.stringify(folha));
ok("categoria de galho e recusada", (await validarCategoria(T, "MLB1000", "x"))?.id !== "MLB1000");
ok("categoria inexistente nao explode", (await validarCategoria(T, "MLB_NAO_EXISTE", "")) === null);

/* ---------- casamento por texto ---------- */
const det = await detalhesCategoria(T, "MLB11172");
const volt = det.atributos.find(a => a.id === "VOLTAGE");
ok("VOLTAGE segue obrigatorio em MLB11172", !!volt?.obrigatorio, det.atributos.map(a => a.id).join(","));
ok("texto '110/220 bivolt' casa com 127/220V", valorPorTexto(volt, "console bivolt")?.nome === "127/220V",
  valorPorTexto(volt, "console bivolt")?.nome);
ok("texto '127V' casa exato", valorPorTexto(volt, "fonte 127V")?.nome === "127V", valorPorTexto(volt, "fonte 127V")?.nome);
// a armadilha: "127/220V" contem "220V", entao a ordem por tamanho importa
ok("'127/220V' nao e confundido com '220V'", valorPorTexto(volt, "fonte 127/220V")?.nome === "127/220V",
  valorPorTexto(volt, "fonte 127/220V")?.nome);
ok("texto sem voltagem nao inventa valor", valorPorTexto(volt, "console retro 64gb") === null);
ok("texto '110V' casa com 127V (mesma rede no Brasil)",
  valorPorTexto(volt, "fonte 110v")?.nome === "127V", valorPorTexto(volt, "fonte 110v")?.nome);
ok("texto '100-240V' casa com bivolt",
  valorPorTexto(volt, "fonte 100-240v")?.nome === "127/220V", valorPorTexto(volt, "fonte 100-240v")?.nome);
ok("padrao de VOLTAGE e bivolt", valorPadrao(volt)?.nome === "127/220V", valorPadrao(volt)?.nome);

/* ---------- o caso que quebrou de verdade, SEM IA ---------- */
const produto = {
  titulo: "VIDEO GAME PORTATIL RETRO ANBERNIC RG35XX H TELA IPS 3.5 DUPLO ANALOGICO WI-FI BLUETOOTH HDMI 64GB",
  tituloML: "Video Game Portatil Retro Anbernic RG35XX H 64GB",
  marca: "Anbernic", modelo: "RG35XX H", descricaoTexto: "Console portatil usado, sem marcas de uso."
};
const r1 = await resolverAtributos(T, "MLB11172", produto, []);
const v1 = temValor(r1.resolvidos, "VOLTAGE");
ok("SEM IA: VOLTAGE resolvido mesmo assim", !!v1, JSON.stringify(v1));
ok("SEM IA: value_id existe na lista do ML", !!v1 && volt.valores.some(x => x.id === v1.value_id), v1?.value_name);
ok("SEM IA: nada fica faltando", r1.faltam.length === 0, r1.faltam.map(a => a.nome).join(","));
console.log("       origem:", r1.origem.join(", "));

/* ---------- titulo com voltagem explicita vence o padrao ---------- */
const r2 = await resolverAtributos(T, "MLB11172", { ...produto, tituloML: produto.tituloML + " 220V" }, []);
ok("voltagem no titulo tem prioridade sobre o padrao",
  temValor(r2.resolvidos, "VOLTAGE")?.value_name === "220V", temValor(r2.resolvidos, "VOLTAGE")?.value_name);

/* ---------- valor vindo do formulario nao e sobrescrito ---------- */
const r3 = await resolverAtributos(T, "MLB11172", produto, [{ id: "VOLTAGE", value_id: volt.valores[0].id }]);
ok("valor do formulario nao e sobrescrito", !temValor(r3.resolvidos, "VOLTAGE"), JSON.stringify(r3.origem));

/* ---------- categoria sem atributos obrigatorios ---------- */
const r4 = await resolverAtributos(T, "MLB438563", produto, []);
ok("categoria sem obrigatorios nao trava", r4.faltam.length === 0 && r4.resolvidos.length === 0);

/* ---------- categoria que exige o que nao da pra adivinhar ---------- */
const r5 = await resolverAtributos(T, "MLB1055", produto, []); // Celulares: exige Anatel etc
ok("categoria impossivel reporta o que falta em vez de publicar torto",
  r5.faltam.length > 0, "faltam: " + r5.faltam.map(a => a.nome).join(", "));

/* ---------- GTIN: checksum antes de gastar chamada ---------- */
ok("EAN-13 real e aceito (7891000053508)", gtinValido("7891000053508"));
ok("EAN-13 com digito trocado e recusado", !gtinValido("7891000053509"));
ok("UPC-A de 12 digitos e aceito (036000291452)", gtinValido("036000291452"));
ok("EAN com traco e limpo antes de conferir", gtinValido("789-1000-053508"));
ok("tamanho invalido e recusado", !gtinValido("12345"));
ok("vazio e recusado", !gtinValido(""));

/* ---------- value_type: o ML recusa value_id em number_unit e boolean ---------- */
const fLista = { id: "COLOR", tipo: "string", valores: [] };
const fNum = { id: "RAM", tipo: "number_unit", valores: [] };
const fBool = { id: "IS_DUAL_SIM", tipo: "boolean", valores: [] };
ok("lista fechada vai por value_id", comoEnviar(fLista, { id: "9", nome: "Preto" }).value_id === "9");
ok("number_unit vai por value_name, sem value_id",
  comoEnviar(fNum, { id: "1", nome: "8 GB" }).value_name === "8 GB" && !comoEnviar(fNum, { id: "1", nome: "8 GB" }).value_id);
ok("boolean vai por value_name, sem value_id",
  comoEnviar(fBool, { id: "2", nome: "Sim" }).value_name === "Sim" && !comoEnviar(fBool, { id: "2", nome: "Sim" }).value_id);

/* ---------- o VOLTAGE real precisa sair no formato que o ML aceita ---------- */
ok("VOLTAGE (string com lista) sai com value_id", !!temValor(r1.resolvidos, "VOLTAGE")?.value_id);

/* ---------- preview da tela nao pode gastar cota de IA ---------- */
const prev = await resolverAtributos(T, "MLB11172", produto, [], { semIA: true });
ok("preview resolve VOLTAGE sem chamar IA", !!temValor(prev.resolvidos, "VOLTAGE"), prev.origem.join(","));

console.log(falhas ? `\n${falhas} teste(s) FALHARAM` : "\nTodos os testes passaram");
process.exit(falhas ? 1 : 0);
