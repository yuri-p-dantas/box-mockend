import type { FastifyInstance } from 'fastify'
import { loadSpec } from './openapi/loader.js'
import { normalize } from './openapi/normalizer.js'
import { createServer } from './server.js'
import type { MockendConfig, RouteDefinition } from './types.js'

export interface Mockend {
  server: FastifyInstance
  routes: RouteDefinition[]
  /** Problemas encontrados na spec que não impedem o Mockend de subir. */
  warnings: string[]
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
  const server = await createServer(routes, config)

  return { server, routes, warnings: [...specWarnings, ...routeWarnings] }
}

export { loadSpec } from './openapi/loader.js'
export { normalize, toFastifyPath } from './openapi/normalizer.js'
export { createServer } from './server.js'
export { buildBody, generate } from './mock/generate.js'
export { selectResponse } from './mock/select-response.js'
export type { HttpMethod, MockendConfig, MockResponse, RouteDefinition, SchemaNode } from './types.js'
