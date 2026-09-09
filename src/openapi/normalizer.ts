import { HTTP_METHODS, type HttpMethod, type MockResponse, type RouteDefinition, type SchemaNode } from '../types.js'
import type { OpenApiDocument } from './loader.js'

export interface NormalizeResult {
  routes: RouteDefinition[]
  warnings: string[]
}

interface ExampleObject {
  value?: unknown
  /** Exemplo hospedado fora do documento. O Mockend não busca URL, então ignora. */
  externalValue?: string
}

interface MediaTypeObject {
  schema?: SchemaNode | null
  example?: unknown
  examples?: Record<string, ExampleObject | null> | null
}

interface ResponseObject {
  content?: Record<string, MediaTypeObject | null> | null
}

const JSON_MEDIA_TYPE = 'application/json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Traduz o path da spec para a sintaxe do Fastify.
 *
 * Absorve dois desvios comuns em specs reais: query string embutida na chave do
 * path (`/order/{id}/print?type={type}`) e path sem barra inicial (`v1/invoice`).
 */
export function toFastifyPath(openapiPath: string, warnings: string[] = []): string {
  let path = openapiPath

  const queryIndex = path.indexOf('?')
  if (queryIndex >= 0) {
    warnings.push(
      `path "${openapiPath}" tem query string na chave do path; a query foi removida da rota ` +
        '(os parâmetros seguem valendo pela declaração em "parameters")',
    )
    path = path.slice(0, queryIndex)
  }

  if (!path.startsWith('/')) {
    warnings.push(`path "${openapiPath}" não começa com "/"; barra inicial adicionada`)
    path = `/${path}`
  }

  return path.replace(/\{([^}]+)\}/g, ':$1')
}

/**
 * Escolhe o media type de uma resposta.
 *
 * Prefere JSON casando por prefixo, para não perder `application/json; charset=utf-8`.
 */
function selectMediaType(
  content: Record<string, MediaTypeObject | null>,
): { contentType: string; media: MediaTypeObject | null } | null {
  const entries = Object.entries(content)
  if (entries.length === 0) return null

  const json = entries.find(([contentType]) => contentType.toLowerCase().startsWith(JSON_MEDIA_TYPE))
  const [contentType, media] = json ?? entries[0]

  return { contentType, media }
}

/**
 * Extrai o exemplo declarado no media type.
 *
 * `example` (singular) vence `examples` (plural) quando os dois existem — a
 * comparação é com `undefined` de propósito, para que um `example: null`
 * explícito continue ganhando.
 *
 * A forma plural é a recomendada pela OpenAPI 3.x e a que a maioria dos
 * geradores de spec produz; ignorá-la deixaria essas specs sem exemplo nenhum.
 * Sem `examples` nomeado escolhido por configuração: vale o primeiro que tiver
 * `value`. Entradas com apenas `externalValue` são puladas, já que o Mockend
 * não busca URL.
 */
function selectExample(media: MediaTypeObject | null): unknown {
  if (media?.example !== undefined) return media.example
  if (!media?.examples) return undefined

  for (const example of Object.values(media.examples)) {
    if (example && typeof example === 'object' && 'value' in example) return example.value
  }

  return undefined
}

function normalizeResponses(
  responses: Record<string, unknown>,
  operationLabel: string,
  warnings: string[],
): MockResponse[] {
  const mockResponses: MockResponse[] = []

  for (const [statusKey, rawResponse] of Object.entries(responses)) {
    const statusCode = Number(statusKey)

    // Três dígitos entre 100 e 599. Sem a checagem, chaves como "0", "999" ou ""
    // (que `Number` converte para 0) chegariam ao `reply.code()` e virariam um
    // erro interno em tempo de requisição, apontando para o lugar errado.
    if (!/^\d{3}$/.test(statusKey) || statusCode < 100 || statusCode > 599) {
      warnings.push(`${operationLabel}: status "${statusKey}" ignorado (não é um status HTTP válido)`)
      continue
    }

    const response = isRecord(rawResponse) ? (rawResponse as ResponseObject) : null
    const content = response?.content

    if (!content || Object.keys(content).length === 0) {
      mockResponses.push({ statusCode, contentType: null, schema: null, example: undefined })
      continue
    }

    const selected = selectMediaType(content)
    if (!selected) {
      mockResponses.push({ statusCode, contentType: null, schema: null, example: undefined })
      continue
    }

    mockResponses.push({
      statusCode,
      contentType: selected.contentType,
      schema: selected.media?.schema ?? null,
      example: selectExample(selected.media),
    })
  }

  return mockResponses.sort((a, b) => a.statusCode - b.statusCode)
}

/** Converte um documento OpenAPI já desreferenciado em rotas. */
export function normalize(document: OpenApiDocument): NormalizeResult {
  const routes: RouteDefinition[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  const paths = isRecord(document.paths) ? document.paths : {}

  for (const [openapiPath, rawPathItem] of Object.entries(paths)) {
    if (!isRecord(rawPathItem)) continue

    const fastifyPath = toFastifyPath(openapiPath, warnings)

    for (const method of HTTP_METHODS) {
      const operation = rawPathItem[method]
      if (!isRecord(operation)) continue

      const httpMethod = method.toUpperCase() as HttpMethod
      const key = `${httpMethod} ${fastifyPath}`

      if (seen.has(key)) {
        warnings.push(`rota duplicada após normalização, ignorada: ${key} (origem: "${openapiPath}")`)
        continue
      }
      seen.add(key)

      const operationId = typeof operation.operationId === 'string' ? operation.operationId : undefined
      const rawResponses = isRecord(operation.responses) ? operation.responses : {}
      const responses = normalizeResponses(rawResponses, key, warnings)

      if (responses.length === 0) {
        warnings.push(`${key}: a spec não declara nenhuma resposta`)
      }

      routes.push({ method: httpMethod, openapiPath, fastifyPath, operationId, responses })
    }
  }

  return { routes, warnings }
}
