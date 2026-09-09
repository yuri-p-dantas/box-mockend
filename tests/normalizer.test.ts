import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadSpec } from '../src/openapi/loader.js'
import { normalize, toFastifyPath, type NormalizeResult } from '../src/openapi/normalizer.js'
import type { RouteDefinition } from '../src/types.js'

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures', name)
const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

const find = (routes: RouteDefinition[], method: string, path: string) =>
  routes.find((route) => route.method === method && route.fastifyPath === path)

// `normalize` é pura, então normalizar uma vez por spec e reaproveitar evita
// reparsear a spec real de 196 KB em cada teste.
let edge: NormalizeResult
let soma: NormalizeResult

beforeAll(async () => {
  edge = normalize((await loadSpec(fixture('edge-cases.json'))).document)
  soma = normalize((await loadSpec(SOMASTORE)).document)
})

describe('toFastifyPath', () => {
  it('converte parâmetros de path', () => {
    expect(toFastifyPath('/v1/cart/{cart_id}/shipping')).toBe('/v1/cart/:cart_id/shipping')
  })

  it('converte múltiplos parâmetros', () => {
    expect(toFastifyPath('/{a}/x/{b}')).toBe('/:a/x/:b')
  })

  it('remove query string embutida na chave do path e avisa', () => {
    const warnings: string[] = []
    expect(toFastifyPath('/order/{order_id}/print?type={type}', warnings)).toBe('/order/:order_id/print')
    expect(warnings[0]).toContain('query string')
  })

  it('adiciona a barra inicial ausente e avisa', () => {
    const warnings: string[] = []
    expect(toFastifyPath('v1/invoice', warnings)).toBe('/v1/invoice')
    expect(warnings[0]).toContain('barra inicial')
  })

  it('deixa paths bem formados intactos', () => {
    const warnings: string[] = []
    expect(toFastifyPath('/product/list', warnings)).toBe('/product/list')
    expect(warnings).toEqual([])
  })
})

describe('normalize', () => {
  it('extrai apenas os métodos suportados, ignorando head', () => {
    const methods = edge.routes
      .filter((route) => route.fastifyPath === '/all-methods/:id')
      .map((route) => route.method)

    expect(methods.sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT'])
  })

  it('ordena as respostas por status crescente', () => {
    const route = find(edge.routes, 'GET', '/lowest-2xx')
    expect(route?.responses.map((response) => response.statusCode)).toEqual([200, 204, 400])
  })

  it('marca contentType null quando a resposta não declara corpo', () => {
    expect(find(edge.routes, 'POST', '/no-content')?.responses[0]).toMatchObject({
      statusCode: 202,
      contentType: null,
      schema: null,
    })
  })

  it('ignora status não numérico e avisa', () => {
    expect(find(edge.routes, 'GET', '/weird-status')?.responses.map((r) => r.statusCode)).toEqual([200])
    expect(edge.warnings.some((warning) => warning.includes('"default"'))).toBe(true)
  })

  it('descarta status fora da faixa HTTP e avisa', () => {
    // "0", "999", "1e3" e "" passariam por uma checagem de inteiro e chegariam
    // ao reply.code(), virando erro interno em tempo de requisição.
    expect(find(edge.routes, 'GET', '/invalid-status')?.responses.map((r) => r.statusCode)).toEqual([200])

    for (const invalid of ['"0"', '"999"', '"1e3"', '""']) {
      expect(
        edge.warnings.some((warning) => warning.includes(invalid) && warning.includes('status HTTP válido')),
        invalid,
      ).toBe(true)
    }
  })

  it('avisa quando a operação não declara nenhuma resposta', () => {
    expect(find(edge.routes, 'DELETE', '/no-responses')?.responses).toEqual([])
    expect(edge.warnings.some((warning) => warning.includes('não declara nenhuma resposta'))).toBe(true)
  })

  it('preserva o path original da spec para diagnóstico', () => {
    expect(find(soma.routes, 'GET', '/order/:order_id/print')?.openapiPath).toBe(
      '/order/{order_id}/print?type={type}',
    )
  })
})

describe('examples do media type', () => {
  it('usa o primeiro examples (plural) quando não há example singular', () => {
    expect(find(edge.routes, 'GET', '/examples-plural')?.responses[0].example).toEqual({
      nome: 'do examples plural',
      preco: 10,
    })
  })

  it('dá precedência ao example singular quando os dois existem', () => {
    expect(find(edge.routes, 'GET', '/examples-both')?.responses[0].example).toEqual({
      nome: 'do example singular',
      preco: 1,
    })
  })

  it('mantém um example singular null vencendo o plural', () => {
    expect(find(edge.routes, 'GET', '/example-null')?.responses[0].example).toBeNull()
  })

  it('pula entradas com apenas externalValue, que o Mockend não busca', () => {
    expect(find(edge.routes, 'GET', '/examples-external')?.responses[0].example).toEqual({
      nome: 'primeiro com value',
      preco: 3,
    })
  })

  it('trata examples vazio como ausência de exemplo', () => {
    expect(find(edge.routes, 'GET', '/examples-empty')?.responses[0].example).toBeUndefined()
  })
})

describe('spec real da Soma Store', () => {
  it('extrai exatamente 43 operações', () => {
    expect(soma.routes).toHaveLength(43)
  })

  it('distribui as operações pelos cinco métodos do MVP', () => {
    const counts = soma.routes.reduce<Record<string, number>>((accumulator, route) => {
      accumulator[route.method] = (accumulator[route.method] ?? 0) + 1
      return accumulator
    }, {})

    expect(counts).toEqual({ GET: 30, POST: 5, DELETE: 4, PATCH: 3, PUT: 1 })
  })

  it('normaliza os dois paths malformados da spec', () => {
    expect(find(soma.routes, 'GET', '/order/:order_id/print')).toBeDefined()
    expect(find(soma.routes, 'GET', '/v1/invoice')).toBeDefined()
    expect(soma.warnings.filter((warning) => warning.includes('query string'))).toHaveLength(1)
    expect(soma.warnings.filter((warning) => warning.includes('barra inicial'))).toHaveLength(1)
  })

  it('não produz rotas duplicadas', () => {
    const keys = soma.routes.map((route) => `${route.method} ${route.fastifyPath}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('todo path normalizado é válido para o Fastify', () => {
    for (const route of soma.routes) {
      expect(route.fastifyPath.startsWith('/')).toBe(true)
      expect(route.fastifyPath).not.toMatch(/[{}?]/)
    }
  })

  it('preserva o content-type com charset declarado na spec', () => {
    expect(find(soma.routes, 'POST', '/order/simulation')?.responses[0].contentType).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('preserva content-type não-JSON', () => {
    expect(find(soma.routes, 'GET', '/order/:order_id/printVoucher')?.responses[0].contentType).toBe(
      'application/pdf',
    )
  })
})
