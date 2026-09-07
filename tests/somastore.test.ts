import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createMockend } from '../src/index.js'
import type { RouteDefinition } from '../src/types.js'

/**
 * Testes contra o contrato real da Soma Store.
 *
 * A spec é tratada como fixture: nunca é ajustada para agradar o Mockend. Cada
 * teste aqui existe por causa de uma característica concreta dela.
 */
const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

/** Substitui `:param` por um valor plausível para conseguir chamar a rota. */
const fillParams = (path: string) => path.replace(/:([^/]+)/g, 'param-value')

/** A resposta que o Mockend vai devolver: a menor 2xx declarada. */
const selected = (route: RouteDefinition) =>
  route.responses.find((response) => response.statusCode >= 200 && response.statusCode < 300)

describe('spec real da Soma Store', () => {
  let server: FastifyInstance
  let routes: RouteDefinition[]
  let warnings: string[]

  beforeAll(async () => {
    const mockend = await createMockend({ spec: SOMASTORE, port: 0, host: '0.0.0.0', delay: 0 })
    server = mockend.server
    routes = mockend.routes
    warnings = mockend.warnings
  })

  afterAll(async () => {
    await server.close()
  })

  it('sobe com as 43 rotas registradas', () => {
    expect(routes).toHaveLength(43)
  })

  it('reporta exatamente os três problemas conhecidos da spec', () => {
    expect(warnings).toHaveLength(3)
    expect(warnings.filter((warning) => warning.includes('IFrameAddress'))).toHaveLength(1)
    expect(warnings.filter((warning) => warning.includes('query string'))).toHaveLength(1)
    expect(warnings.filter((warning) => warning.includes('barra inicial'))).toHaveLength(1)
  })

  // O teste de maior valor do projeto: varre o contrato inteiro.
  it('responde todas as 43 rotas com o status declarado e sem erro interno', async () => {
    const failures: string[] = []

    for (const route of routes) {
      const expected = selected(route)?.statusCode

      const response = await server.inject({ method: route.method, url: fillParams(route.fastifyPath) })

      if (response.statusCode !== expected) {
        failures.push(`${route.method} ${route.fastifyPath}: esperado ${expected}, recebido ${response.statusCode}`)
      }

      if (response.headers['x-mockend-error']) {
        failures.push(`${route.method} ${route.fastifyPath}: erro interno do Mockend`)
      }
    }

    expect(failures).toEqual([])
  })

  it('devolve JSON parseável em toda rota que declara corpo', async () => {
    const withBody = routes.filter((route) =>
      selected(route)?.contentType?.startsWith('application/json'),
    )

    expect(withBody).toHaveLength(38)

    for (const route of withBody) {
      const response = await server.inject({ method: route.method, url: fillParams(route.fastifyPath) })
      expect(() => response.json(), `${route.method} ${route.fastifyPath}`).not.toThrow()
    }
  })

  it('responde sem corpo nas operações cujo 2xx não declara conteúdo', async () => {
    const withoutBody = routes.filter((route) => selected(route)?.contentType === null)

    expect(withoutBody).toHaveLength(4)

    for (const route of withoutBody) {
      const response = await server.inject({ method: route.method, url: fillParams(route.fastifyPath) })
      expect(response.body, `${route.method} ${route.fastifyPath}`).toBe('')
    }
  })

  it('serve rotas com parâmetro de path', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/cart/abc-123/shipping' })
    expect(response.statusCode).toBe(200)
  })

  it('serve o path que tinha query string embutida na chave', async () => {
    const response = await server.inject({ method: 'GET', url: '/order/42/print?type=invoice' })
    expect(response.statusCode).toBe(200)
  })

  it('serve o path que não tinha barra inicial', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/invoice' })
    expect(response.statusCode).toBe(200)
  })

  it('preserva o content-type com charset', async () => {
    const response = await server.inject({ method: 'POST', url: '/order/simulation' })

    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(() => response.json()).not.toThrow()
  })

  it('preserva o content-type application/pdf', async () => {
    const response = await server.inject({ method: 'GET', url: '/order/42/printVoucher' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
  })

  it('devolve null no type "file" herdado de Swagger 2.0 em vez de quebrar', async () => {
    const response = await server.inject({ method: 'GET', url: '/invoice/nfe-1/pdf' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toBeNull()
  })

  it('aproveita o único schema example do contrato', async () => {
    const response = await server.inject({ method: 'GET', url: '/store/card-brands' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).not.toEqual({})
  })

  it('aproveita example declarado em propriedade aninhada', async () => {
    // Único `example` de propriedade alcançável a partir de uma resposta nesta
    // spec: ClusterStatementTransaction.label. Sem precedência aplicada por nó,
    // este valor viraria "string".
    const response = await server.inject({ method: 'GET', url: '/customer/statement' })

    expect(JSON.stringify(response.json())).toContain('Cashback gerado')
  })

  it('serve as operações de manual-integration, cujo 200 não declara corpo', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await server.inject({ method, url: '/v1/order/payment/manual-integration' })

      expect(response.statusCode, method).toBe(200)
      expect(response.body, method).toBe('')
    }
  })

  it('não quebra na rota cujo schema tem o $ref não resolvido', async () => {
    const withBrokenRef = routes.filter((route) =>
      JSON.stringify(route.responses).includes('"address":null'),
    )

    for (const route of withBrokenRef) {
      const response = await server.inject({ method: route.method, url: fillParams(route.fastifyPath) })
      expect(response.headers['x-mockend-error'], `${route.method} ${route.fastifyPath}`).toBeUndefined()
    }
  })

  it('gera respostas determinísticas', async () => {
    const first = await server.inject({ method: 'GET', url: '/v1/product/list' })
    const second = await server.inject({ method: 'GET', url: '/v1/product/list' })

    expect(first.body).toBe(second.body)
  })
})
