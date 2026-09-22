// Confere o codigo contra a spec tecnica de integracao (os 31 comportamentos validados
// em producao). Roda sem rede e sem chave nenhuma:  node scripts/conferir-spec.mjs
import fs from "node:fs";
const s = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const h = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const src = s + h;
const itens = [
 ["1", "refresh_token persistido em disco", /writeJson\(TOKEN_FILE/.test(s)],
 ["1", "retry em falha transitoria de rede do ML", /MLTRANSITORIO|tentativa \+ 1/.test(s)],
 ["1", "trava contra renovacao concorrente do token", /renovandoML/.test(s)],
 ["2", "family_name pela tag user_product_seller", /user_product_seller/.test(s)],
 ["2", "family_name limitado a 60 caracteres", /slice\(0,\s*60\)/.test(src)],
 ["2", "categoria vinda de domain_discovery", /domain_discovery/.test(s)],
 ["2", "categoria validada antes de usar (folha + listing_allowed)", /listing_allowed/.test(s)],
 ["2", "category_predictor morto nao e mais chamado",
      !s.split("\n").filter(l=>!l.trim().startsWith("//")).join("\n").includes("category_predictor")],
 ["2", "atributos obrigatorios por tags.required", /catalog_required|\.required/.test(s)],
 ["2", "string com lista -> value_id", /value_id: valor\.id/.test(s)],
 ["2", "number_unit -> value_name", /number_unit/.test(s)],
 ["2", "boolean -> value_name", /"boolean"/.test(s)],
 ["2", "GTIN tratado como obrigatorio sempre", /EMPTY_GTIN_REASON/.test(s)],
 ["2", "checksum de GTIN antes de enviar", /gtinValido/.test(s)],
 ["2", "GTIN nunca inventado", !/gerarGtin|fakeGtin|randomGtin/i.test(s)],
 ["2", "fotos: upload binario, nunca link do Drive no ML", /pictures\/items\/upload/.test(s)],
 ["2", "limite de 12 fotos no ML", /slice\(0, 12\)/.test(s)],
 ["2", "listing_type_id gold_special", /gold_special/.test(s)],
 ["2", "condition configuravel (used/new)", /condition: condicao|b\.usado/.test(s)],
 ["2", "descricao: POST e PUT se ja existir", /"PUT".*description|method: "PUT"/s.test(s)],
 ["3", "Shopify: inventoryItem tracked", /tracked: true/.test(s)],
 ["3", "Shopify: confirma tracked depois de criar", /inventoryItemUpdate/.test(s)],
 ["3", "Shopify: nome errado inventoryItemTracked NAO usado", !/inventoryItemTracked/.test(s)],
 ["3", "Shopify: publishablePublish", /publishablePublish/.test(s)],
 ["3", "Shopify: CONFIRMA publicacao no canal", /publishedOnPublication/.test(s)],
 ["3", "Shopify: link do Drive funciona (usa url direta)", /originalSource/.test(s)],
 ["4", "titulo Shopify em CAIXA ALTA", /toUpperCase\(\)/.test(s)],
 ["4", "frase padrao de produto usado do canal", /Geek Antenado/.test(s)],
 ["4", "preco separado por plataforma", /precoShopify/.test(s) && /precoML/.test(s)],
 ["5", "busca fotos por nome do produto na pasta", /name contains/.test(s)],
 ["6", "erro de IA nao bloqueia a publicacao", /erroIA/.test(s)],
];
let sec = "", falta = 0;
for (const [n, desc, ok] of itens) {
  if (n !== sec) { console.log(`\n--- secao ${n} da spec ---`); sec = n; }
  console.log(`${ok ? "OK    " : "FALTA "} ${desc}`);
  if (!ok) falta++;
}
console.log(falta ? `\n${falta} item(ns) da spec NAO atendidos` : "\nTodos os itens da spec atendidos");
