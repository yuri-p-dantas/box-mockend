import type { FastifyInstance } from 'fastify'
import { checkMocks, type MockContractIssue, resolveMocks } from './mock/overrides.js'
import { loadSpec } from './openapi/loader.js'
import { normalize } from './openapi/normalizer.js'
import { createServer } from './server.js'
import type { MockendConfig, RouteDefinition } from './types.js'

export interface Mockend {
  server: FastifyInstance
  routes: RouteDefinition[]
  /** Problemas na spec ou nos mocks que não impedem o Mockend de subir. */
  warnings: string[]
  /** Quantos arquivos de mock casaram com uma rota no momento da subida. */
  mocksFound: number
  /** Divergências entre mocks e contrato. Vazio quando `checkMocks` está desligado. */
  mockIssues: MockContractIssue[]
}

/**
 * Monta o Mockend a partir de uma spec: carrega, normaliza e registra as rotas.
 *
 * Não faz `listen` nem imprime nada — isso é responsabilidade da CLI, o que
 * mantém esta função utilizável em testes via `server.inject()`.
 */
export async function createMockend(config: MockendConfig): Promise<Mockend> {
  const { document, warnings: specWarnings } = await loadSpec(config.spec)
  const { routes, warnings: routeWarnings } = normalize(document)

  const mocks = config.mocks
    ? await resolveMocks(routes, config.mocks)
    : { routes, warnings: [], found: 0 }

  const server = await createServer(mocks.routes, config)

  // Auditoria: nunca impede a subida nem muda o que é servido.
  const mockIssues = config.checkMocks ? await checkMocks(mocks.routes) : []

  return {
    server,
    routes: mocks.routes,
    warnings: [...specWarnings, ...routeWarnings, ...mocks.warnings],
    mocksFound: mocks.found,
    mockIssues,
  }
}

export { loadSpec } from './openapi/loader.js'
export { normalize, toFastifyPath } from './openapi/normalizer.js'
export { createServer } from './server.js'
export { buildBody, generate } from './mock/generate.js'
export { checkMocks, mockFilePath, readMock, resolveMocks } from './mock/overrides.js'
export type { MockContractIssue } from './mock/overrides.js'
export { selectResponse } from './mock/select-response.js'
export type { HttpMethod, MockendConfig, MockResponse, RouteDefinition, SchemaNode } from './types.js'
