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
yarn dev          # sobe com a spec e os mocks de examples/
```

`yarn dev` é um atalho para a spec de exemplo. Para qualquer outra spec, use `yarn mockend`:

```bash
yarn mockend --spec ./caminho/da/spec.yaml --port 4000
```

Argumentos extras passados ao `yarn dev` sobrescrevem os padrões:

```bash
yarn dev --port 5000 --delay 300
```

```
box-mockend --spec <caminho> [opções]

  --spec <caminho>   Spec OpenAPI 3.x em JSON ou YAML (obrigatório)
  --port <número>    Porta HTTP (padrão: 4000)
  --host <endereço>  Interface de bind (padrão: 0.0.0.0)
  --delay <ms>       Atraso global antes de cada resposta (padrão: 0)
  --mocks <dir>      Diretório com mocks por rota (padrão: ./mocks, se existir)
  --check-mocks      Audita os mocks contra os schemas da spec
  --help             Ajuda
```

No startup o Mockend imprime os avisos sobre a spec e a tabela de rotas registradas.

O bind padrão é `0.0.0.0`, então o servidor também é alcançável pelo emulador Android
(`10.0.2.2:<porta>`) e por dispositivos na mesma rede. CORS fica liberado para qualquer origem.

Use `--delay` para exercitar estados de carregamento na interface.

## Mocks por rota

O OpenAPI descreve o **contrato**: o que existe, com que método e que status. Mas o corpo
gerado a partir do schema é genérico — na prática, `"string"` e `0` em todo campo que o
contrato não exemplifica. Para desenvolver uma tela de verdade você precisa dos **dados**.

Então: **a OpenAPI é o contrato, o mock é o dado.** Você fornece o corpo num arquivo
separado, sem tocar na spec.

O caminho do arquivo espelha a URL, e o método é o nome do arquivo:

```
GET  /v1/product/list              →  mocks/v1/product/list/GET.json
GET  /v1/cart/{cart_id}/shipping   →  mocks/v1/cart/[cart_id]/shipping/GET.json
POST /order                        →  mocks/order/POST.json
```

O conteúdo é **apenas o corpo da resposta**:

```json
{
  "data": [{ "id": "1001", "name": "Vestido Midi Plissado", "current_price": 899.9 }],
  "metadata": { "total": 1 }
}
```

Status e content-type continuam vindo da spec. Nada do contrato é reescrito no arquivo, e
**um mock nunca cria uma rota**: arquivo que não corresponde a nenhuma operação é ignorado
e reportado no startup. A OpenAPI segue sendo a fonte única do que existe.

As rotas com mock aparecem marcadas na tabela de startup:

```
GET  /v1/product/list  200,401  (GetProductListV1)  [mock]
```

### Vários cenários na mesma rota

Quando uma rota precisa de mais de uma resposta, o arquivo vira **pasta**, e cada status
é um arquivo dentro dela:

```
mocks/order/[order_id]/
├── GET.json          ← resposta padrão (formato simples, continua valendo)
└── GET/
    ├── 200.json      ← ou assim, um arquivo por status
    ├── 400.json
    └── 500.json
```

Para escolher o cenário, use o header padrão **`Prefer: code=<status>`** (RFC 7240):

```bash
curl http://localhost:4000/order/123                        # 200
curl -H 'Prefer: code=400' http://localhost:4000/order/123  # 400
```

No frontend, um interceptor de axios/fetch ativo só em dev resolve — dá para ligar o
cenário de erro numa tela sem afetar as outras.

**Sem `Prefer`**, o comportamento é o de sempre: a menor 2xx da spec.

**Com `Prefer: code=X`**, em ordem:

| Situação | Resposta |
| --- | --- |
| existe `GET/X.json` | status X com o corpo do arquivo |
| não existe, mas a spec declara X | status X com o corpo do contrato |
| nem um nem outro | `400 MOCKEND_NO_MOCK_FOR_STATUS`, listando os status disponíveis |

O último caso é deliberado: **cair em silêncio para o 200 seria o pior desfecho**. A tela
mostraria sucesso e você concluiria que o tratamento de erro funciona sem nunca tê-lo
exercitado.

Como **28 das 43 rotas da spec de exemplo já declaram mais de um status**, o `Prefer`
funciona em boa parte delas sem criar arquivo nenhum.

`GET.json` só vale para o status padrão. Ele é *o corpo da resposta padrão*, e servi-lo
sob um status de erro entregaria o corpo de sucesso com status errado.

As duas formas convivem numa mesma rota: `GET.json` + `GET/400.json` é uso misto
legítimo. O único conflito é ter `GET.json` e `GET/<statusPadrão>.json` ao mesmo tempo —
aí a pasta vence e sai um aviso no startup.

### Recarga sem reiniciar

Os arquivos são lidos **a cada requisição**. Editar o JSON e recarregar a tela basta —
não é preciso reiniciar o Mockend. Criar um arquivo novo passa a valer na hora, inclusive
um cenário de status novo, e apagá-lo volta ao comportamento anterior.

Se o JSON estiver inválido, a rota responde 500 com `MOCKEND_INVALID_MOCK` nomeando o
arquivo. É proposital: cair em silêncio para o dado gerado esconderia o erro.

### Campos fora do schema

São permitidos, e esse é o caso de uso central — backend frequentemente entrega campo
antes de documentar.

Para enxergar essas divergências, rode com `--check-mocks`:

```bash
yarn dev --check-mocks
```

```
Divergências entre mocks e contrato:
  Campos declarados nos mocks que a OpenAPI não descreve. Pode ser campo que o
  backend real já devolve e o contrato ainda não documenta — não é necessariamente
  erro no mock. Só nomes de propriedade são comparados; tipos não são validados.

  [warning] GET /v1/product/list
      GET/200.json declara "data[].badge", que não existe no schema do 200
      GET/400.json declara o status 400, que a spec não documenta
```

É **auditoria, não validação**: não impede o servidor de subir nem o mock de ser
servido. A comparação é só de nomes de propriedade, recursiva em objetos e arrays —
não há validação de tipo e não usamos `ajv`.

A auditoria reporta duas coisas: **campo** fora do schema e **status** que a spec não
documenta — este último aparece quando você cria um `400.json` numa rota que o contrato
só descreve como 200.

Divergência não é sinônimo de erro. Nos mocks de exemplo deste repositório, `badge` é
invenção deliberada, mas `metadata.page_size` e `store.package_types[].modality` são
campos que o backend real devolve e a OpenAPI não documenta. Nesse caso a lista vira
insumo para o time de backend atualizar o contrato.

> **Dados sintéticos apenas.** Arquivos de mock são versionados e parecem dados de
> produção. Nunca coloque dado real de cliente neles.

Veja [examples/mocks/](examples/mocks/) para um exemplo funcionando.

## Como as respostas são montadas

**Qual resposta:** a menor 2xx declarada na operação. Sem 2xx, a menor resposta declarada —
uma operação que só documenta 404 devolve 404.

**Qual corpo**, em ordem de precedência:

1. **mock em arquivo** (veja acima)
2. `example` da resposta
3. `examples` da resposta — o primeiro com `value`
4. `example` do schema
5. primeiro valor do `enum`
6. geração por `type`

Os níveis 4 a 6 são aplicados em **cada nó** do schema, o que aproveita `example`
declarado em propriedade individual.

O nível 3 existe porque `examples` (plural) é a forma recomendada pela OpenAPI 3.x e a
que a maioria dos geradores de spec produz. Entradas com apenas `externalValue` são
puladas: o Mockend não busca URL. O mock, quando existe, substitui o corpo inteiro —
nunca há merge com o dado gerado.

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
| 400 | `MOCKEND_INVALID_PREFER` | o `Prefer: code=` não é um status HTTP válido |
| 400 | `MOCKEND_NO_MOCK_FOR_STATUS` | o status pedido não tem mock nem está no contrato |
| 500 | `MOCKEND_INVALID_MOCK` | o arquivo de mock não é um JSON válido |
| 501 | `MOCKEND_NO_RESPONSE_DEFINED` | a operação não declara nenhuma resposta |
| 500 | `MOCKEND_INTERNAL_ERROR` | falha inesperada ao montar a resposta |

A regra por trás dos códigos: **5xx quando o Mockend não consegue de jeito nenhum**
(o contrato está vazio, algo quebrou), **4xx quando o que *você pediu* não está
disponível**.

## Specs com defeito

Specs reais têm defeitos, e o Mockend prefere subir com aviso a não subir:

- **`$ref` quebrado** não derruba o boot — o nó não resolvido vira `null` e o problema
  aparece como aviso. A spec de exemplo já teve um caso desses; hoje ele é coberto pela
  fixture de teste.
- **Query string na chave do path** (`/order/{id}/print?type={type}`) é removida da rota;
  os parâmetros continuam valendo pela declaração em `parameters`.
- **Path sem barra inicial** (`v1/invoice`) ganha a barra.
- **Tipo desconhecido** (como o `type: "file"` herdado de Swagger 2.0) vira `null`.
- **Status fora da faixa HTTP** (`0`, `999`) é descartado com aviso, em vez de virar erro
  na primeira requisição.

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
    overrides.ts        mocks por arquivo e auditoria contra o contrato
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

Proxy para o backend real, fallback quando o backend cai, cenários por requisição
(mockar 404/500 sob demanda), estado em memória, autenticação simulada, validação de
request e geração sofisticada de dados. A arquitetura comporta essas evoluções, mas nada
foi abstraído antecipadamente para elas.

Quando o envelope com status e headers for necessário, ele entra por outro nome de arquivo
(`GET.response.json`), nunca por uma chave dentro do JSON — assim nunca colide com um
corpo que por acaso tenha um campo `status` ou `body`.
