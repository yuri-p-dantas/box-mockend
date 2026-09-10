# box-mockend — Guia para o Claude Code

Servidor HTTP de mock orientado por OpenAPI, usado por times de frontend do grupo
**AZZAS 2154** para desenvolver telas antes de o backend estar pronto.

Leia o [README.md](README.md) para uso e comportamento. Este arquivo cobre o que importa
ao mexer no código.

## Princípios do projeto

> **O Mockend é genérico. Tudo o que ele sabe sobre uma API vem da spec passada em `--spec`.**

Não existe conhecimento de API específica no código: nenhum endpoint, schema ou regra da
Soma Store — ou de qualquer outra API — pode aparecer em `src/`.

> **Mocks fornecem dados, nunca contrato.**

Um arquivo de mock contém só o corpo. Ele não declara path, método, status nem
content-type, e **nunca cria uma rota** — arquivo sem operação correspondente é ignorado
com aviso. A OpenAPI segue sendo a fonte única do que existe.

Os outros três, em ordem de importância:

1. **Simplicidade acima de extensibilidade.** Sem interfaces, dependency injection, plugins
   internos ou abstrações genéricas sem cliente. Evolução futura se resolve com refactor
   quando chegar, não com camada antecipada.
2. **`src/mock` não conhece Fastify; `src/server` não conhece OpenAPI.** As duas metades
   conversam por `RouteDefinition` (`src/types.ts`). É a única fronteira estrutural — mantenha-a.
3. **Determinismo.** A mesma requisição devolve sempre o mesmo corpo. Nada de faker, `Math.random`
   ou `Date.now()` no caminho de geração.

## Stack

Node ≥ 20.9 · TypeScript 5.6 (ESM, `module: NodeNext` — imports relativos levam `.js`) ·
Yarn 4.9.2 via Corepack · Fastify 5 · Vitest 3.

Vitest está fixado em 3.x de propósito: a 5.x exige Node ≥ 20.12 e o ambiente de
desenvolvimento está no 20.9. Ao subir o Node, dá para subir o Vitest junto.

Três dependências de runtime, e a intenção é que continue assim:
`fastify`, `@fastify/cors`, `@apidevtools/json-schema-ref-parser`.

> Não escreva parser de OpenAPI. A resolução de `$ref` é do `json-schema-ref-parser`.
> `@apidevtools/swagger-parser` **não serve**: a versão 13 faz `require()` de um pacote
> ESM-only e quebra no Node 20.

## Fluxo

```
cli.ts → createMockend()
           ├─ loader.loadSpec()       lê JSON/YAML, resolve $ref
           ├─ normalizer.normalize()  → RouteDefinition[]
           ├─ overrides.resolveMocks() anexa mockFile e denuncia órfãos
           └─ createServer()          registra as rotas no Fastify
       → tabela de rotas → listen

requisição → selectResponse() → readMock() → buildBody() → delay → reply
```

Precedência do corpo:
**mock em arquivo → `example` → `examples` → example do schema → enum → type.**
Os dois primeiros níveis ficam em `buildBody`; o `examples` plural é resolvido no
normalizer, que já reduz `example`/`examples` a um único campo em `MockResponse`.
O mock ganha inclusive do `example` da spec — o arquivo é deliberado, o exemplo é
genérico — e substitui o corpo inteiro, sem merge.

`RouteDefinition.mockBase` guarda o **caminho sem extensão**, não o conteúdo nem a lista
de arquivos. `<base>.json` é a resposta padrão e `<base>/<status>.json` são os cenários.
A existência é verificada a cada requisição, o que dá recarga automática sem watcher:
editar, criar e apagar arquivos — inclusive cenários novos — valem na hora. Enumerar no
boot mataria isso.

## Cenários por status (`Prefer: code=`)

`Prefer: code=400` (RFC 7240, não um `x-mockend-*` inventado) escolhe o cenário. A ordem:
arquivo `<base>/400.json` → resposta 400 declarada na spec → **recusa explícita**.

> **Nunca caia em silêncio para o 200 quando o status pedido não existir.**

É a regra de segurança central desta funcionalidade: a tela mostraria sucesso e o dev
concluiria que o tratamento de erro funciona sem nunca tê-lo exercitado. A recusa é
`400 MOCKEND_NO_MOCK_FOR_STATUS` e **lista os status disponíveis**, que é o que resolve
o problema na hora.

`400` e não `501`: o 501 do RFC 9110 é orientado a método não suportado e — o argumento
decisivo — é **cacheável por padrão**, o que numa ferramenta de alternar cenários seria
péssimo. O `501` fica só para `MOCKEND_NO_RESPONSE_DEFINED`, onde a deficiência é do
contrato e o cliente não tem como consertar mudando a requisição.

`<base>.json` só serve o status padrão. Servi-lo sob um status de erro entregaria o corpo
de sucesso com status errado — daí o parâmetro `allowSingleFile` de `lookupMock`.

`parseHttpStatus` (em `types.ts`) é compartilhada entre o normalizer e o parsing do
`Prefer` para que os dois lados sigam exatamente a mesma regra de status válido.

## Auditoria de mocks (`--check-mocks`)

Compara os campos dos mocks com `schema.properties` da resposta e reporta os que o
contrato não declara. **É auditoria, não validação**: não bloqueia a subida nem muda o
que é servido. Só nomes de propriedade, recursivo em objetos e arrays, sem `ajv`.

`resolveSchema` é exportada de `generate.ts` e usada nos dois lados de propósito: se a
auditoria resolvesse `allOf` por conta própria, as duas visões do schema divergiriam.

O texto do aviso precisa continuar deixando claro que divergência **não é sinônimo de
erro no mock** — a causa mais comum é a OpenAPI estar atrasada em relação ao backend.

## A spec de exemplo é fixture, não configuração

`examples/somastore-openapi.json` é o contrato real da Soma Store, mantido como fixture de
teste. **Nunca a edite** — nem para corrigir os defeitos dela. Cada defeito é tratado em
`src/` e coberto em `tests/somastore.test.ts`:

| Defeito na spec | Tratamento |
| --- | --- |
| `$ref` quebrado (`IFrameAddress`) | loader tolera, avisa, nó vira `null` |
| `/order/{order_id}/print?type={type}` | normalizer remove a query da chave do path |
| `v1/invoice` sem barra inicial | normalizer adiciona a barra |
| `type: "file"` (Swagger 2.0) | gerador devolve `null` para tipo desconhecido |

Ao encontrar um novo defeito em qualquer spec: trate no código, emita aviso, escreva teste.
Nunca ajuste a spec.

## Testes

```bash
yarn test
```

`tests/somastore.test.ts` roda contra a spec real e é a rede de segurança mais valiosa do
projeto: varre as 43 operações e afirma que todas respondem sem erro interno. Os números
fixos nesses testes (43 rotas, 3 avisos, 38 com corpo JSON, 4 sem corpo) são intencionais —
se mudarem, entenda o porquê antes de atualizar.

`tests/fixtures/edge-cases.json` cobre o que a spec real não tem: `oneOf`, `anyOf`, schema
recursivo, array sem `items`, operação sem respostas, status inválido.

`tests/mocks.test.ts` usa diretórios temporários (`mkdtemp`) em vez de fixtures fixas,
porque precisa escrever, editar e apagar arquivos durante o teste para exercitar a recarga.

## Armadilhas conhecidas

- **`Dirent.parentPath` não existe no Node 20.9** (só `path`, renomeado na 20.12).
  `overrides.ts` usa recursão explícita em vez de `readdir({ recursive: true })` por isso.
- **Vitest 5 exige Node ≥ 20.12** (`styleText`). Daí o pin em 3.x.
- **`@apidevtools/swagger-parser` quebra no Node 20** com `ERR_REQUIRE_ESM`.
