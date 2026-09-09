import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createMockend } from '../src/index.js'
import type { RouteDefinition } from '../src/types.js'

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures', name)

describe('servidor com a spec de casos de borda', () => {
  let server: FastifyInstance
  let routes: RouteDefinition[]

  beforeAll(async () => {
    const mockend = await createMockend({ spec: fixture('edge-cases.json'), port: 0, host: '0.0.0.0', delay: 0 })
    server = mockend.server
    routes = mockend.routes
  })

  afterAll(async () => {
    await server.close()
  })

  it('responde com o example declarado na resposta', async () => {
    const response = await server.inject({ method: 'GET', url: '/response-example' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: 'vindo do example da resposta' })
  })

  it('resolve allOf, oneOf e anyOf num corpo coerente', async () => {
    const response = await server.inject({ method: 'GET', url: '/composition' })

    expect(response.json()).toEqual({
      merged: { id: 0, kind: 'string', extra: true },
      chosen: 'string',
      alternative: true,
    })
  })

  it('responde schema recursivo sem travar', async () => {
    const response = await server.inject({ method: 'GET', url: '/recursive' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('label', 'string')
  })

  it('trata os casos degenerados de schema', async () => {
    const response = await server.inject({ method: 'GET', url: '/degenerate' })

    expect(response.json()).toEqual({
      emptyObject: {},
      arrayWithoutItems: [],
      unknownType: null,
      inferredObject: { inner: 0 },
    })
  })

  it('devolve o status declarado e corpo vazio quando a spec não declara conteúdo', async () => {
    const response = await server.inject({ method: 'POST', url: '/no-content' })

    expect(response.statusCode).toBe(202)
    expect(response.body).toBe('')
  })

  it('devolve a menor 2xx mesmo quando ela não é a primeira da spec', async () => {
    const response = await server.inject({ method: 'GET', url: '/lowest-2xx' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ picked: 'string' })
  })

  it('devolve o status de erro quando a operação só documenta erros', async () => {
    const response = await server.inject({ method: 'GET', url: '/errors-only' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ code: 0 })
    expect(response.headers['x-mockend-error']).toBeUndefined()
  })

  it('sinaliza 501 quando a operação não declara nenhuma resposta', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/no-responses' })

    expect(response.statusCode).toBe(501)
    expect(response.headers['x-mockend-error']).toBe('true')
    expect(response.json().error).toBe('MOCKEND_NO_RESPONSE_DEFINED')
  })

  it('responde null no nó de $ref quebrado sem derrubar a rota', async () => {
    const response = await server.inject({ method: 'GET', url: '/broken-ref' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toBeNull()
  })

  it('serve a operação cujos outros status são inválidos, sem erro interno', async () => {
    const response = await server.inject({ method: 'GET', url: '/invalid-status' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-mockend-error']).toBeUndefined()
    expect(response.json()).toEqual({ ok: true })
  })

  it('serve o corpo vindo de examples (plural)', async () => {
    const response = await server.inject({ method: 'GET', url: '/examples-plural' })

    expect(response.json()).toEqual({ nome: 'do examples plural', preco: 10 })
  })

  it('cai para a geração por type quando examples está vazio', async () => {
    const response = await server.inject({ method: 'GET', url: '/examples-empty' })

    expect(response.json()).toEqual({ nome: 'string', preco: 0 })
  })

  it('registra os cinco métodos do MVP', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await server.inject({ method, url: '/all-methods/123' })
      expect(response.statusCode).toBe(200)
    }
  })

  it('serve HEAD espelhando o GET, como faz um servidor HTTP real', async () => {
    // A operação `head` da spec não vira rota (ver normalizer.test.ts); o HEAD
    // que responde aqui é o que o Fastify deriva automaticamente do GET.
    const response = await server.inject({ method: 'HEAD', url: '/all-methods/123' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('')
  })

  describe('erros do próprio Mockend', () => {
    it('distingue rota fora da spec de um 404 mockado', async () => {
      const response = await server.inject({ method: 'GET', url: '/rota-que-nao-existe' })

      expect(response.statusCode).toBe(404)
      expect(response.headers['x-mockend-error']).toBe('true')
      expect(response.json()).toMatchObject({
        error: 'MOCKEND_ROUTE_NOT_FOUND',
        message: expect.stringContaining('/rota-que-nao-existe'),
      })
    })

    it('trata método não declarado para um path existente como rota inexistente', async () => {
      const response = await server.inject({ method: 'POST', url: '/response-example' })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('MOCKEND_ROUTE_NOT_FOUND')
    })
  })

  it('libera CORS para uso a partir do navegador', async () => {
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/response-example',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })

  it('expõe as rotas normalizadas para a tabela de startup', () => {
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.every((route) => route.fastifyPath.startsWith('/'))).toBe(true)
  })
})

describe('--delay', () => {
  it('aplica o atraso global antes de responder', async () => {
    const { server } = await createMockend({
      spec: fixture('minimal.yaml'),
      port: 0,
      host: '0.0.0.0',
      delay: 120,
    })

    const started = Date.now()
    const response = await server.inject({ method: 'GET', url: '/ping' })
    const elapsed = Date.now() - started

    expect(response.statusCode).toBe(200)
    expect(elapsed).toBeGreaterThanOrEqual(110)

    await server.close()
  })

  it('não atrasa quando o delay é zero', async () => {
    const { server } = await createMockend({ spec: fixture('minimal.yaml'), port: 0, host: '0.0.0.0', delay: 0 })

    const started = Date.now()
    await server.inject({ method: 'GET', url: '/ping' })

    expect(Date.now() - started).toBeLessThan(100)

    await server.close()
  })
})
