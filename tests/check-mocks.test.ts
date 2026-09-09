import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createMockend } from '../src/index.js'

const CHECK = resolve(import.meta.dirname, 'fixtures', 'check-mocks.json')
const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

describe('--check-mocks', () => {
  let mocksDir: string
  let server: FastifyInstance | undefined

  const write = async (relativePath: string, content: unknown) => {
    const file = join(mocksDir, relativePath)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }

  const audit = async (spec = CHECK, checkMocks = true) => {
    const mockend = await createMockend({
      spec,
      port: 0,
      host: '0.0.0.0',
      delay: 0,
      mocks: mocksDir,
      checkMocks,
    })
    server = mockend.server
    return mockend
  }

  /** Campos reportados para uma rota, ou `[]` se a rota não tiver divergência. */
  const fieldsOf = (issues: { route: string; fields: string[] }[], route: string) =>
    issues.find((issue) => issue.route === route)?.fields ?? []

  beforeEach(async () => {
    mocksDir = await mkdtemp(join(tmpdir(), 'mockend-check-'))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(mocksDir, { recursive: true, force: true })
  })

  it('reporta campo desconhecido no topo', async () => {
    await write('produto/GET.json', { id: '1', desconto: 10 })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /produto')).toEqual(['desconto'])
  })

  it('reporta campo desconhecido em objeto aninhado', async () => {
    await write('produto/GET.json', { fabricante: { nome: 'Animale', cnpj: '00000000000000' } })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /produto')).toEqual(['fabricante.cnpj'])
  })

  it('reporta campo desconhecido dentro de item de array', async () => {
    await write('produto/GET.json', { tags: [{ label: 'novo', cor: '#000' }] })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /produto')).toEqual(['tags[].cor'])
  })

  it('percorre todos os elementos do array, não só o primeiro', async () => {
    await write('produto/GET.json', {
      tags: [{ label: 'ok' }, { label: 'novo', cor: '#000' }, { label: 'x', peso: 1 }],
    })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /produto')).toEqual(['tags[].cor', 'tags[].peso'])
  })

  it('não repete o mesmo campo achado em vários elementos', async () => {
    await write('produto/GET.json', { tags: [{ cor: 'a' }, { cor: 'b' }, { cor: 'c' }] })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /produto')).toEqual(['tags[].cor'])
  })

  it('não reporta nada quando o mock respeita o schema', async () => {
    await write('produto/GET.json', { id: '1', preco: 9.9, fabricante: { nome: 'Animale' }, tags: [{ label: 'novo' }] })

    const { mockIssues } = await audit()

    expect(mockIssues).toEqual([])
  })

  it('resolve allOf antes de comparar', async () => {
    await write('composto/GET.json', { base: 'a', extra: true, inventado: 1 })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /composto')).toEqual(['inventado'])
  })

  it('não reporta em schema de objeto livre, sem properties', async () => {
    await write('livre/GET.json', { qualquer: 'coisa', outro: 2 })

    const { mockIssues } = await audit()

    expect(mockIssues).toEqual([])
  })

  it('ignora rota cuja resposta não declara schema', async () => {
    await write('sem-schema/GET.json', { qualquer: 'coisa' })

    const { mockIssues } = await audit()

    expect(mockIssues).toEqual([])
  })

  it('não reporta rotas sem mock', async () => {
    await write('produto/GET.json', { id: '1' })

    const { mockIssues } = await audit()

    expect(mockIssues.map((issue) => issue.route)).not.toContain('GET /livre')
  })

  it('não roda a auditoria quando a flag está desligada', async () => {
    await write('produto/GET.json', { desconto: 10 })

    const { mockIssues } = await audit(CHECK, false)

    expect(mockIssues).toEqual([])
  })

  it('tolera mock com JSON inválido sem quebrar a auditoria', async () => {
    await write('produto/GET.json', '{ "quebrado": ')
    await write('composto/GET.json', { inventado: 1 })

    const { mockIssues } = await audit()

    expect(fieldsOf(mockIssues, 'GET /composto')).toEqual(['inventado'])
  })

  describe('é auditoria, não validação', () => {
    it('não impede o servidor de subir nem o mock de ser servido', async () => {
      await write('produto/GET.json', { id: '1', desconto: 10 })

      const { server, mockIssues } = await audit()
      const response = await server.inject({ method: 'GET', url: '/produto' })

      expect(mockIssues).toHaveLength(1)
      expect(response.statusCode).toBe(200)
      expect(response.headers['x-mockend-error']).toBeUndefined()
      expect(response.json()).toEqual({ id: '1', desconto: 10 })
    })
  })

  it('encontra as divergências reais dos mocks de exemplo da Soma Store', async () => {
    await write('v1/product/list/GET.json', { data: [{ id: '1', badge: 'ÚLTIMAS PEÇAS' }] })

    const { mockIssues } = await audit(SOMASTORE)

    expect(fieldsOf(mockIssues, 'GET /v1/product/list')).toEqual(['data[].badge'])
  })
})
