/** Métodos HTTP que o Mockend registra. */
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>

/**
 * Subconjunto de JSON Schema que o gerador entende, já desreferenciado.
 *
 * Nós podem vir `null`: quando a spec tem um `$ref` quebrado, o loader mantém
 * o documento utilizável e o nó não resolvido vira `null`.
 */
export interface SchemaNode {
  type?: string | string[]
  format?: string
  properties?: Record<string, SchemaNode | null>
  items?: SchemaNode | null
  enum?: unknown[]
  example?: unknown
  allOf?: (SchemaNode | null)[]
  oneOf?: (SchemaNode | null)[]
  anyOf?: (SchemaNode | null)[]
  minItems?: number
  maxItems?: number
  minimum?: number
  [keyword: string]: unknown
}

/** Uma resposta possível de uma operação, já reduzida ao que o mock precisa. */
export interface MockResponse {
  statusCode: number
  /** `null` quando a spec não declara corpo para esta resposta. */
  contentType: string | null
  schema: SchemaNode | null
  /** `example` declarado no media type da resposta. */
  example: unknown
}

/**
 * Tudo o que o servidor precisa para servir uma rota.
 *
 * É o contrato entre as metades do Mockend: quem produz não conhece Fastify;
 * quem consome não conhece OpenAPI.
 */
export interface RouteDefinition {
  method: HttpMethod
  /** Path como está na spec, usado em log e mensagens de erro. */
  openapiPath: string
  /** Path traduzido para a sintaxe do Fastify. */
  fastifyPath: string
  operationId?: string
  /** Ordenadas por `statusCode` crescente. */
  responses: MockResponse[]
  /**
   * Arquivo de mock desta rota. Não vem da OpenAPI: é o caminho onde o usuário
   * pode colocar um corpo próprio. Definido quando há um diretório de mocks
   * configurado, exista o arquivo ou não — a existência é verificada a cada
   * requisição, o que dá recarga automática sem watcher.
   */
  mockFile?: string
}

export interface MockendConfig {
  spec: string
  port: number
  host: string
  /** Atraso global em ms aplicado antes de cada resposta. */
  delay: number
  /** Diretório com os mocks por rota. Ausente desativa a funcionalidade. */
  mocks?: string
}
