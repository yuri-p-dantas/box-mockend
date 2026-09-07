import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSpec } from '../src/openapi/loader.js'
import { normalize, toFastifyPath } from '../src/openapi/normalizer.js'
import type { RouteDefinition } from '../src/types.js'

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures', name)
const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

const find = (routes: RouteDefinition[], method: string, path: string) =>
  routes.find((route) => route.method === method && route.fastifyPath === path)

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
  it('extrai apenas os métodos suportados, ignorando head', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes } = normalize(document)

    const methods = routes.filter((route) => route.fastifyPath === '/all-methods/:id').map((route) => route.method)

    expect(methods.sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT'])
  })

  it('ordena as respostas por status crescente', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes } = normalize(document)

    const route = find(routes, 'GET', '/lowest-2xx')
    expect(route?.responses.map((response) => response.statusCode)).toEqual([200, 204, 400])
  })

  it('marca contentType null quando a resposta não declara corpo', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes } = normalize(document)

    expect(find(routes, 'POST', '/no-content')?.responses[0]).toMatchObject({
      statusCode: 202,
      contentType: null,
      schema: null,
    })
  })

  it('ignora status não numérico e avisa', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes, warnings } = normalize(document)

    expect(find(routes, 'GET', '/weird-status')?.responses.map((r) => r.statusCode)).toEqual([200])
    expect(warnings.some((warning) => warning.includes('"default"'))).toBe(true)
  })

  it('descarta status fora da faixa HTTP e avisa', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes, warnings } = normalize(document)

    // "0", "999", "1e3" e "" passariam por uma checagem de inteiro e chegariam
    // ao reply.code(), virando erro interno em tempo de requisição.
    expect(find(routes, 'GET', '/invalid-status')?.responses.map((r) => r.statusCode)).toEqual([200])

    for (const invalid of ['"0"', '"999"', '"1e3"', '""']) {
      expect(
        warnings.some((warning) => warning.includes(invalid) && warning.includes('status HTTP válido')),
        invalid,
      ).toBe(true)
    }
  })

  it('avisa quando a operação não declara nenhuma resposta', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const { routes, warnings } = normalize(document)

    expect(find(routes, 'DELETE', '/no-responses')?.responses).toEqual([])
    expect(warnings.some((warning) => warning.includes('não declara nenhuma resposta'))).toBe(true)
  })

  it('preserva o path original da spec para diagnóstico', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    expect(find(routes, 'GET', '/order/:order_id/print')?.openapiPath).toBe('/order/{order_id}/print?type={type}')
  })
})

describe('spec real da Soma Store', () => {
  it('extrai exatamente 43 operações', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    expect(routes).toHaveLength(43)
  })

  it('distribui as operações pelos cinco métodos do MVP', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    const counts = routes.reduce<Record<string, number>>((accumulator, route) => {
      accumulator[route.method] = (accumulator[route.method] ?? 0) + 1
      return accumulator
    }, {})

    expect(counts).toEqual({ GET: 30, POST: 5, DELETE: 4, PATCH: 3, PUT: 1 })
  })

  it('normaliza os dois paths malformados da spec', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes, warnings } = normalize(document)

    expect(find(routes, 'GET', '/order/:order_id/print')).toBeDefined()
    expect(find(routes, 'GET', '/v1/invoice')).toBeDefined()
    expect(warnings.filter((warning) => warning.includes('query string'))).toHaveLength(1)
    expect(warnings.filter((warning) => warning.includes('barra inicial'))).toHaveLength(1)
  })

  it('não produz rotas duplicadas', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    const keys = routes.map((route) => `${route.method} ${route.fastifyPath}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('todo path normalizado é válido para o Fastify', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    for (const route of routes) {
      expect(route.fastifyPath.startsWith('/')).toBe(true)
      expect(route.fastifyPath).not.toMatch(/[{}?]/)
    }
  })

  it('preserva o content-type com charset declarado na spec', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    expect(find(routes, 'POST', '/order/simulation')?.responses[0].contentType).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('preserva content-type não-JSON', async () => {
    const { document } = await loadSpec(SOMASTORE)
    const { routes } = normalize(document)

    expect(find(routes, 'GET', '/order/:order_id/printVoucher')?.responses[0].contentType).toBe('application/pdf')
  })
})
