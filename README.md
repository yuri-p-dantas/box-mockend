# box-mockend

Servidor HTTP de mock **orientado por especificação OpenAPI**.

Serve para desenvolver o frontend antes de o backend existir, sem trocar mocks em objeto
no código por mocks em objeto no código: a aplicação faz uma requisição HTTP de verdade e
recebe uma resposta HTTP de verdade, montada a partir do contrato da API.

```
Frontend ──HTTP──▶ Mockend ──lê──▶ OpenAPI ──▶ resposta mockada
```

O Mockend é genérico: não conhece nenhuma API específica. Tudo o que ele sabe vem da spec
passada em `--spec`.

## Requisitos

- Node ≥ 20.9
- Yarn 4 via Corepack (`corepack enable`)

## Uso

```bash
yarn install
yarn mockend --spec ./examples/somastore-openapi.json --port 4000
```

```
box-mockend --spec <caminho> [opções]

  --spec <caminho>   Spec OpenAPI 3.x em JSON ou YAML (obrigatório)
  --port <número>    Porta HTTP (padrão: 4000)
  --host <endereço>  Interface de bind (padrão: 0.0.0.0)
  --delay <ms>       Atraso global antes de cada resposta (padrão: 0)
  --help             Ajuda
```

No startup o Mockend imprime os avisos sobre a spec e a tabela de rotas registradas.

O bind padrão é `0.0.0.0`, então o servidor também é alcançável pelo emulador Android
(`10.0.2.2:<porta>`) e por dispositivos na mesma rede. CORS fica liberado para qualquer origem.

Use `--delay` para exercitar estados de carregamento na interface.

## Como as respostas são montadas

**Qual resposta:** a menor 2xx declarada na operação. Sem 2xx, a menor resposta declarada —
uma operação que só documenta 404 devolve 404.

**Qual corpo**, em ordem de precedência, aplicada em **cada nó** do schema:

1. `example` da resposta
2. `example` do schema
3. primeiro valor do `enum`
4. geração por `type`

A geração por `type` é deliberadamente simples e **determinística** — a mesma requisição
devolve sempre o mesmo corpo, sem faker e sem aleatoriedade. Arrays recebem 3 itens
(respeitando `minItems`/`maxItems`), `format` conhecido vira valor fixo (`date-time`, `uuid`,
`email`, …), e a recursão tem limite de profundidade para que schemas cíclicos não travem
o processo.

`allOf` é achatado combinando as `properties`; `oneOf`/`anyOf` usam o primeiro ramo.

## Erros do Mockend

Uma falha do Mockend nunca pode ser confundida com uma resposta mockada da API. Todas saem
com o header `x-mockend-error: true` e um corpo padronizado:

| Status | `error` | Quando |
| --- | --- | --- |
| 404 | `MOCKEND_ROUTE_NOT_FOUND` | a rota não existe na spec carregada |
| 501 | `MOCKEND_NO_RESPONSE_DEFINED` | a operação não declara nenhuma resposta |
| 500 | `MOCKEND_INTERNAL_ERROR` | falha inesperada ao montar a resposta |

## Specs com defeito

Specs reais têm defeitos, e o Mockend prefere subir com aviso a não subir:

- **`$ref` quebrado** não derruba o boot — o nó não resolvido vira `null` e o problema
  aparece como aviso.
- **Query string na chave do path** (`/order/{id}/print?type={type}`) é removida da rota;
  os parâmetros continuam valendo pela declaração em `parameters`.
- **Path sem barra inicial** (`v1/invoice`) ganha a barra.
- **Tipo desconhecido** (como o `type: "file"` herdado de Swagger 2.0) vira `null`.

Falha de parsing que impeça entender o documento, essa sim derruba o processo.

## Arquitetura

```
src/
  cli.ts              parsing de argumentos, tabela de rotas, listen
  index.ts            createMockend(): carrega, normaliza e registra
  types.ts            RouteDefinition e afins
  openapi/
    loader.ts         lê JSON/YAML e resolve $ref
    normalizer.ts     documento OpenAPI → RouteDefinition[]
  server.ts           RouteDefinition[] → rotas Fastify
  mock/
    select-response.ts  qual status devolver
    generate.ts         qual corpo devolver
```

A única fronteira estrutural: **`src/mock` não conhece Fastify e `src/server` não conhece
OpenAPI**. As duas metades conversam por `RouteDefinition`.

`createMockend()` não faz `listen` nem imprime nada, o que permite usá-lo em testes com
`server.inject()`.

## Desenvolvimento

```bash
yarn test        # suíte completa
yarn test:watch
yarn typecheck
yarn build
```

`examples/somastore-openapi.json` é uma spec real usada como fixture. Ela **não** é
configuração do Mockend e nunca deve ser ajustada para agradá-lo — os defeitos dela são
tratados no código e cobertos por testes em `tests/somastore.test.ts`.

## Fora do escopo por ora

Proxy para o backend real, fallback quando o backend cai, cenários por requisição,
overrides por arquivo, estado em memória, autenticação simulada, validação de request e
geração sofisticada de dados. A arquitetura comporta essas evoluções, mas nada foi
abstraído antecipadamente para elas.
