import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createMockend } from '../src/index.js'
import { listMockStatuses, lookupMock } from '../src/mock/overrides.js'

const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

/**
 * Rotas reais usadas aqui, e por que cada uma:
 *
 *   GET  /order/{order_id}                    declara SÓ 200 — é o caso motivador
 *   GET  /v1/product/list                     declara 200 e 401 (401 sem corpo)
 *   POST /v1/order/payment/manual-integration declara 400 COM schema
 */
describe('múltiplas respostas por rota', () => {
  let mocksDir: string
  let server: FastifyInstance | undefined

  const write = async (relativePath: string, content: unknown) => {
    const file = join(mocksDir, relativePath)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }

  const boot = async (checkMocks = false) => {
    const mockend = await createMockend({
      spec: SOMASTORE,
      port: 0,
      host: '0.0.0.0',
      delay: 0,
      mocks: mocksDir,
      checkMocks,
    })
    server = mockend.server
    return mockend
  }

  const get = (url: string, code?: string | number) =>
    server!.inject({ method: 'GET', url, headers: code === undefined ? {} : { prefer: `code=${code}` } })

  beforeEach(async () => {
    mocksDir = await mkdtemp(join(tmpdir(), 'mockend-status-'))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(mocksDir, { recursive: true, force: true })
  })

  describe('o caso motivador: erro que a spec não documenta', () => {
    beforeEach(async () => {
      await write('order/[order_id]/GET/200.json', { id: '123', status: 'CONFIRMADO' })
      await write('order/[order_id]/GET/400.json', {
        code: '@OrderRepository/ORDER_NOT_FOUND',
        message: 'Pedido não encontrado usando a id .',
      })
    })

    it('sem Prefer, serve o 200', async () => {
      await boot()
      const response = await get('/order/123')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ id: '123', status: 'CONFIRMADO' })
    })

    it('com Prefer: code=400, serve o 400 mesmo a spec só declarando 200', async () => {
      await boot()
      const response = await get('/order/123', 400)

      expect(response.statusCode).toBe(400)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.headers['x-mockend-error']).toBeUndefined()
      expect(response.json()).toEqual({
        code: '@OrderRepository/ORDER_NOT_FOUND',
        message: 'Pedido não encontrado usando a id .',
      })
    })

    it('a auditoria reporta que o 400 não está no contrato', async () => {
      const { mockIssues } = await boot(true)
      const issue = mockIssues.find((candidate) => candidate.status === 400)

      expect(issue?.undeclaredStatus).toBe(true)
      expect(issue?.route).toBe('GET /order/:order_id')
      expect(issue?.file).toContain('400.json')
    })
  })

  describe('status pedido sem mock', () => {
    it('usa o contrato quando a spec declara o status, sem precisar de arquivo', async () => {
      await boot()
      // /v1/product/list declara 401 sem corpo.
      const response = await get('/v1/product/list', 401)

      expect(response.statusCode).toBe(401)
      expect(response.headers['x-mockend-error']).toBeUndefined()
      expect(response.body).toBe('')
    })

    it('gera o corpo pelo schema quando a spec declara o status com schema', async () => {
      await boot()
      const response = await server!.inject({
        method: 'POST',
        url: '/v1/order/payment/manual-integration',
        headers: { prefer: 'code=400' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.headers['x-mockend-error']).toBeUndefined()
      expect(() => response.json()).not.toThrow()
    })

    it('recusa explicitamente quando nem a spec nem um mock fornecem o status', async () => {
      await boot()
      const response = await get('/order/123', 400)

      expect(response.statusCode).toBe(400)
      expect(response.headers['x-mockend-error']).toBe('true')
      expect(response.json().error).toBe('MOCKEND_NO_MOCK_FOR_STATUS')
    })

    it('lista os status disponíveis na mensagem de recusa', async () => {
      await write('order/[order_id]/GET/404.json', {})
      await boot()

      const message = (await get('/order/123', 500)).json().message

      expect(message).toContain('200')
      expect(message).toContain('404')
    })

    it('nunca cai em silêncio para o 200', async () => {
      await write('order/[order_id]/GET/200.json', { sucesso: true })
      await boot()

      const response = await get('/order/123', 503)

      expect(response.json()).not.toEqual({ sucesso: true })
      expect(response.headers['x-mockend-error']).toBe('true')
    })
  })

  describe('header Prefer', () => {
    it('recusa status fora da faixa HTTP', async () => {
      await boot()
      const response = await get('/v1/product/list', 999)

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('MOCKEND_INVALID_PREFER')
    })

    it('recusa valor não numérico', async () => {
      await boot()
      const response = await get('/v1/product/list', 'abc')

      expect(response.json().error).toBe('MOCKEND_INVALID_PREFER')
    })

    it('ignora outras preferências na mesma linha', async () => {
      await write('v1/product/list/GET/401.json', { erro: 'nao autorizado' })
      await boot()

      const response = await server!.inject({
        method: 'GET',
        url: '/v1/product/list',
        headers: { prefer: 'respond-async, code=401, wait=10' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ erro: 'nao autorizado' })
    })

    it('sem "code", comporta-se como se não houvesse Prefer', async () => {
      await write('v1/product/list/GET.json', { padrao: true })
      await boot()

      const response = await server!.inject({
        method: 'GET',
        url: '/v1/product/list',
        headers: { prefer: 'respond-async' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ padrao: true })
    })
  })

  describe('convivência entre GET.json e GET/', () => {
    it('GET.json + GET/400.json é uso misto legítimo, sem aviso de conflito', async () => {
      await write('order/[order_id]/GET.json', { doArquivoUnico: true })
      await write('order/[order_id]/GET/400.json', { doCenario: true })

      const { warnings } = await boot()

      expect(warnings.filter((warning) => warning.includes('mesmo status'))).toHaveLength(0)
      expect((await get('/order/1')).json()).toEqual({ doArquivoUnico: true })
      expect((await get('/order/1', 400)).json()).toEqual({ doCenario: true })
    })

    it('GET.json + GET/200.json disputam o mesmo status: a pasta vence e sai aviso', async () => {
      await write('order/[order_id]/GET.json', { origem: 'arquivo unico' })
      await write('order/[order_id]/GET/200.json', { origem: 'pasta' })

      const { warnings } = await boot()

      expect(warnings.some((warning) => warning.includes('mesmo status 200'))).toBe(true)
      expect((await get('/order/1')).json()).toEqual({ origem: 'pasta' })
    })

    it('GET.json não é usado para um status que não é o padrão', async () => {
      // A spec declara 400 com schema para esta rota; o arquivo único não deve
      // ser servido sob status de erro.
      await write('v1/order/payment/manual-integration/POST.json', { corpoDeSucesso: true })
      await boot()

      const response = await server!.inject({
        method: 'POST',
        url: '/v1/order/payment/manual-integration',
        headers: { prefer: 'code=400' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).not.toEqual({ corpoDeSucesso: true })
    })
  })

  describe('arquivo de cenário quebrado', () => {
    beforeEach(async () => {
      await write('order/[order_id]/GET/200.json', { ok: true })
      await write('order/[order_id]/GET/400.json', '{ "quebrado": ')
    })

    it('não afeta os outros cenários da mesma rota', async () => {
      await boot()
      const response = await get('/order/1')

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    })

    it('falha nomeando o arquivo quando aquele cenário é pedido', async () => {
      await boot()
      const response = await get('/order/1', 400)

      expect(response.statusCode).toBe(500)
      expect(response.json().error).toBe('MOCKEND_INVALID_MOCK')
      expect(response.json().message).toContain('400.json')
    })
  })

  describe('recarga sem reiniciar', () => {
    it('um cenário criado depois da subida passa a valer na hora', async () => {
      await write('order/[order_id]/GET/200.json', { ok: true })
      await boot()

      expect((await get('/order/1', 500)).json().error).toBe('MOCKEND_NO_MOCK_FOR_STATUS')

      await write('order/[order_id]/GET/500.json', { falha: 'interna' })

      const response = await get('/order/1', 500)
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ falha: 'interna' })
    })

    it('apagar o cenário volta a recusar o status', async () => {
      await write('order/[order_id]/GET/400.json', { erro: true })
      await boot()

      expect((await get('/order/1', 400)).statusCode).toBe(400)
      expect((await get('/order/1', 400)).json()).toEqual({ erro: true })

      await rm(join(mocksDir, 'order/[order_id]/GET/400.json'))

      expect((await get('/order/1', 400)).json().error).toBe('MOCKEND_NO_MOCK_FOR_STATUS')
    })
  })

  describe('órfãos e contagem', () => {
    it('avisa quando o nome dentro da pasta não é um status', async () => {
      await write('order/[order_id]/GET/sucesso.json', {})

      const { warnings, mocksFound } = await boot()

      expect(mocksFound).toBe(0)
      expect(warnings.some((warning) => warning.includes('sucesso.json') && warning.includes('status HTTP'))).toBe(
        true,
      )
    })

    it('avisa quando o status do nome está fora da faixa', async () => {
      await write('order/[order_id]/GET/999.json', {})

      const { warnings, mocksFound } = await boot()

      expect(mocksFound).toBe(0)
      expect(warnings.some((warning) => warning.includes('999.json'))).toBe(true)
    })

    it('conta arquivos de cenário junto com os de resposta única', async () => {
      await write('order/[order_id]/GET/200.json', {})
      await write('order/[order_id]/GET/400.json', {})
      await write('v1/product/list/GET.json', {})

      const { mocksFound, warnings } = await boot()

      expect(mocksFound).toBe(3)
      expect(warnings.filter((warning) => warning.includes('ignorado'))).toHaveLength(0)
    })
  })

  describe('auditoria com múltiplos status', () => {
    it('compara os campos de cada arquivo com o schema do seu próprio status', async () => {
      await write('v1/product/list/GET/200.json', { data: [{ id: '1', badge: 'NOVO' }] })

      const { mockIssues } = await boot(true)
      const issue = mockIssues.find((candidate) => candidate.status === 200)

      expect(issue?.fields).toEqual(['data[].badge'])
      expect(issue?.undeclaredStatus).toBeUndefined()
    })

    it('reporta status não declarado sem inventar campos', async () => {
      await write('order/[order_id]/GET/500.json', { qualquer: 'coisa' })

      const { mockIssues } = await boot(true)

      expect(mockIssues).toHaveLength(1)
      expect(mockIssues[0]).toMatchObject({ status: 500, undeclaredStatus: true, fields: [] })
    })
  })

  it('aplica o --delay também quando o cenário vem do Prefer', async () => {
    await write('order/[order_id]/GET/400.json', { erro: true })
    const mockend = await createMockend({
      spec: SOMASTORE,
      port: 0,
      host: '0.0.0.0',
      delay: 120,
      mocks: mocksDir,
    })
    server = mockend.server

    const started = Date.now()
    const response = await get('/order/1', 400)

    expect(response.statusCode).toBe(400)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
  })
})

describe('lookupMock e listMockStatuses', () => {
  let dir: string

  const write = async (relativePath: string, content: unknown) => {
    const file = join(dir, relativePath)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mockend-lookup-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('prefere o arquivo de status ao arquivo único', async () => {
    await write('GET.json', { origem: 'unico' })
    await write('GET/200.json', { origem: 'status' })

    expect((await lookupMock(join(dir, 'GET'), 200, true)).body).toEqual({ origem: 'status' })
  })

  it('cai para o arquivo único quando permitido', async () => {
    await write('GET.json', { origem: 'unico' })

    expect((await lookupMock(join(dir, 'GET'), 200, true)).body).toEqual({ origem: 'unico' })
  })

  it('não cai para o arquivo único quando o status não é o padrão', async () => {
    await write('GET.json', { origem: 'unico' })

    expect(await lookupMock(join(dir, 'GET'), 400, false)).toEqual({})
  })

  it('devolve vazio quando não há nada', async () => {
    expect(await lookupMock(join(dir, 'GET'), 200, true)).toEqual({})
  })

  it('devolve o erro de parsing junto com o arquivo', async () => {
    await write('GET/400.json', '{ "quebrado": ')

    const lookup = await lookupMock(join(dir, 'GET'), 400, false)

    expect(lookup.file).toContain('400.json')
    expect(lookup.error).toBeTruthy()
    expect(lookup.body).toBeUndefined()
  })

  it('lista os status em ordem, ignorando nomes inválidos', async () => {
    await write('GET/500.json', {})
    await write('GET/200.json', {})
    await write('GET/sucesso.json', {})
    await write('GET/999.json', {})

    expect(await listMockStatuses(join(dir, 'GET'))).toEqual([200, 500])
  })

  it('devolve lista vazia quando a pasta não existe', async () => {
    expect(await listMockStatuses(join(dir, 'NAO_EXISTE'))).toEqual([])
  })
})
