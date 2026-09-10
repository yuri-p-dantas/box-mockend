import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createMockend } from '../src/index.js'
import { mockBasePath, singleMockFile } from '../src/mock/overrides.js'
import type { RouteDefinition } from '../src/types.js'

const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')
const EDGE_CASES = resolve(import.meta.dirname, 'fixtures', 'edge-cases.json')

const route = (method: string, fastifyPath: string) =>
  ({ method, fastifyPath, openapiPath: fastifyPath, responses: [] }) as unknown as RouteDefinition

describe('mockBasePath', () => {
  const single = (dir: string, method: string, path: string) =>
    singleMockFile(mockBasePath(dir, route(method, path)))

  it('espelha a URL em diretórios com o método como nome do arquivo', () => {
    expect(single('/mocks', 'GET', '/v1/product/list')).toBe('/mocks/v1/product/list/GET.json')
  })

  it('usa [param] para parâmetros de path', () => {
    expect(single('/mocks', 'GET', '/v1/cart/:cart_id/shipping')).toBe(
      '/mocks/v1/cart/[cart_id]/shipping/GET.json',
    )
  })

  it('distingue métodos no mesmo path', () => {
    expect(single('/mocks', 'POST', '/order')).toBe('/mocks/order/POST.json')
    expect(single('/mocks', 'DELETE', '/order')).toBe('/mocks/order/DELETE.json')
  })

  it('lida com a raiz', () => {
    expect(single('/mocks', 'GET', '/')).toBe('/mocks/GET.json')
  })

  it('devolve a base sem extensão, usada também para a pasta de cenários', () => {
    expect(mockBasePath('/mocks', route('GET', '/v1/product/list'))).toBe('/mocks/v1/product/list/GET')
  })
})

describe('mocks por arquivo', () => {
  let mocksDir: string
  let server: FastifyInstance | undefined

  const write = async (relativePath: string, content: unknown) => {
    const file = join(mocksDir, relativePath)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }

  const boot = async (spec = SOMASTORE) => {
    const mockend = await createMockend({ spec, port: 0, host: '0.0.0.0', delay: 0, mocks: mocksDir })
    server = mockend.server
    return mockend
  }

  beforeEach(async () => {
    mocksDir = await mkdtemp(join(tmpdir(), 'mockend-'))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(mocksDir, { recursive: true, force: true })
  })

  it('serve o corpo do arquivo no lugar do dado gerado', async () => {
    await write('v1/product/list/GET.json', {
      data: [{ id: '1', name: 'Vestido Midi', current_price: 899.9 }],
      metadata: { total: 1 },
    })

    const { server } = await boot()
    const response = await server.inject({ method: 'GET', url: '/v1/product/list' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: [{ id: '1', name: 'Vestido Midi', current_price: 899.9 }],
      metadata: { total: 1 },
    })
  })

  it('mantém status e content-type vindos da spec', async () => {
    await write('order/simulation/POST.json', { total: 100 })

    const { server } = await boot()
    const response = await server.inject({ method: 'POST', url: '/order/simulation' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('vence o example declarado na spec', async () => {
    // /store/card-brands é a única rota da spec com example de schema.
    const semMock = await createMockend({ spec: SOMASTORE, port: 0, host: '0.0.0.0', delay: 0 })
    const original = await semMock.server.inject({ method: 'GET', url: '/store/card-brands' })
    expect(original.json()).toHaveProperty('credit')
    await semMock.server.close()

    await write('store/card-brands/GET.json', { credit: [], debit: [] })

    const { server } = await boot()
    const response = await server.inject({ method: 'GET', url: '/store/card-brands' })

    expect(response.json()).toEqual({ credit: [], debit: [] })
  })

  it('serve rota com parâmetro de path para qualquer valor do parâmetro', async () => {
    await write('v1/cart/[cart_id]/shipping/GET.json', { marker: 'mockado' })

    const { server } = await boot()

    for (const cartId of ['abc-123', '42']) {
      const response = await server.inject({ method: 'GET', url: `/v1/cart/${cartId}/shipping` })
      expect(response.json(), cartId).toEqual({ marker: 'mockado' })
    }
  })

  it('distingue métodos no mesmo path', async () => {
    await write('v1/cart/DELETE.json', { deleted: true })

    const { server } = await boot()

    expect((await server.inject({ method: 'DELETE', url: '/v1/cart' })).json()).toEqual({ deleted: true })
    expect((await server.inject({ method: 'GET', url: '/v1/cart' })).json()).not.toEqual({ deleted: true })
  })

  it('aceita qualquer JSON como corpo, inclusive array e primitivo', async () => {
    await write('v1/product/list/GET.json', [1, 2, 3])

    const { server } = await boot()
    expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).toEqual([1, 2, 3])
  })

  it('permite campos que não existem no schema', async () => {
    await write('v1/product/list/GET.json', {
      data: [{ id: '1', discount_badge: 'BLACK FRIDAY', badge_color: '#000' }],
    })

    const { server } = await boot()
    const body = (await server.inject({ method: 'GET', url: '/v1/product/list' })).json()

    expect(body.data[0].discount_badge).toBe('BLACK FRIDAY')
  })

  it('não afeta as rotas sem mock', async () => {
    await write('v1/product/list/GET.json', { data: [] })

    const { server } = await boot()
    const response = await server.inject({ method: 'GET', url: '/customer' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-mockend-error']).toBeUndefined()
    expect(JSON.stringify(response.json())).toContain('string')
  })

  it('não cria rota que não existe na spec', async () => {
    await write('rota/inventada/GET.json', { nope: true })

    const { server } = await boot()
    const response = await server.inject({ method: 'GET', url: '/rota/inventada' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('MOCKEND_ROUTE_NOT_FOUND')
  })

  it('avisa sobre arquivo que não corresponde a nenhuma rota', async () => {
    await write('v1/produto/list/GET.json', { typo: true })

    const { warnings, mocksFound } = await boot()

    expect(mocksFound).toBe(0)
    expect(warnings.some((warning) => warning.includes('v1/produto/list/GET.json'))).toBe(true)
  })

  it('conta quantos mocks casaram com uma rota', async () => {
    await write('v1/product/list/GET.json', {})
    await write('customer/GET.json', {})
    await write('nao/existe/GET.json', {})

    const { mocksFound, warnings } = await boot()

    expect(mocksFound).toBe(2)
    expect(warnings.filter((warning) => warning.includes('não corresponde'))).toHaveLength(1)
  })

  describe('recarga sem reiniciar', () => {
    it('reflete a edição do arquivo na requisição seguinte', async () => {
      await write('v1/product/list/GET.json', { versao: 1 })

      const { server } = await boot()
      expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).toEqual({ versao: 1 })

      await write('v1/product/list/GET.json', { versao: 2 })
      expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).toEqual({ versao: 2 })
    })

    it('passa a servir um mock criado depois da subida', async () => {
      const { server } = await boot()
      expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).not.toEqual({ novo: true })

      await write('v1/product/list/GET.json', { novo: true })
      expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).toEqual({ novo: true })
    })

    it('volta a gerar pelo contrato quando o arquivo é apagado', async () => {
      await write('v1/product/list/GET.json', { fixo: true })

      const { server } = await boot()
      expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).json()).toEqual({ fixo: true })

      await rm(join(mocksDir, 'v1/product/list/GET.json'))
      const response = await server.inject({ method: 'GET', url: '/v1/product/list' })

      expect(response.statusCode).toBe(200)
      expect(response.headers['x-mockend-error']).toBeUndefined()
      expect(response.json()).toHaveProperty('metadata')
    })
  })

  it('falha explicitamente quando o JSON do mock é inválido', async () => {
    await write('v1/product/list/GET.json', '{ "quebrado": ')

    const { server } = await boot()
    const response = await server.inject({ method: 'GET', url: '/v1/product/list' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['x-mockend-error']).toBe('true')
    expect(response.json().error).toBe('MOCKEND_INVALID_MOCK')
    expect(response.json().message).toContain('GET.json')
  })

  it('aplica mock mesmo quando a spec declara a resposta sem corpo', async () => {
    // O 200 de PATCH /customer/address não declara content. O mock vence assim
    // mesmo: o arquivo é uma decisão deliberada do desenvolvedor.
    await write('customer/address/PATCH.json', { agora: 'tem corpo' })

    const { server } = await boot()
    const response = await server.inject({ method: 'PATCH', url: '/customer/address' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ agora: 'tem corpo' })
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('funciona com o path que a spec declarava com query string embutida', async () => {
    await write('order/[order_id]/print/GET.json', { pronto: true })

    const { server } = await boot()
    expect((await server.inject({ method: 'GET', url: '/order/9/print?type=invoice' })).json()).toEqual({
      pronto: true,
    })
  })

  it('desativa a funcionalidade quando nenhum diretório é configurado', async () => {
    await write('v1/product/list/GET.json', { naoDeveAparecer: true })

    const mockend = await createMockend({ spec: SOMASTORE, port: 0, host: '0.0.0.0', delay: 0 })
    server = mockend.server

    const body = (await server.inject({ method: 'GET', url: '/v1/product/list' })).json()

    expect(body).not.toEqual({ naoDeveAparecer: true })
    expect(mockend.routes.every((route) => route.mockBase === undefined)).toBe(true)
  })

  it('ignora diretório de mocks inexistente sem quebrar', async () => {
    await rm(mocksDir, { recursive: true, force: true })

    const { server, warnings, mocksFound } = await boot()

    expect(mocksFound).toBe(0)
    expect(warnings.filter((warning) => warning.includes('não corresponde'))).toHaveLength(0)
    expect((await server.inject({ method: 'GET', url: '/v1/product/list' })).statusCode).toBe(200)
  })

  it('serve mock numa spec sem operationId', async () => {
    await write('response-example/GET.json', { doArquivo: true })

    const { server } = await boot(EDGE_CASES)
    expect((await server.inject({ method: 'GET', url: '/response-example' })).json()).toEqual({ doArquivo: true })
  })
})
