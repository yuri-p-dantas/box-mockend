/** Métodos HTTP que o Mockend registra. */
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>

/**
 * Converte um status vindo de texto em número, ou `null` se não for válido.
 *
 * Usada tanto para as chaves de `responses` da spec quanto para o `Prefer:
 * code=` da requisição, para que os dois lados sigam exatamente a mesma regra:
 * três dígitos entre 100 e 599. Recusa `""`, `"0"`, `"1e3"` e `"999"`.
 */
export function parseHttpStatus(raw: string): number | null {
  if (!/^\d{3}$/.test(raw)) return null

  const status = Number(raw)

  return status >= 100 && status <= 599 ? status : null
}

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
   * Base para localizar os mocks desta rota, sem extensão. Não vem da OpenAPI.
   *
   *   `<base>.json`          → resposta padrão (formato original)
   *   `<base>/<status>.json` → uma resposta por status
   *
   * Guardamos a base, não a lista de arquivos: a existência é verificada a cada
   * requisição, o que mantém a recarga automática valendo inclusive para
   * cenários criados depois da subida.
   */
  mockBase?: string
}

export interface MockendConfig {
  spec: string
  port: number
  host: string
  /** Atraso global em ms aplicado antes de cada resposta. */
  delay: number
  /** Diretório com os mocks por rota. Ausente desativa a funcionalidade. */
  mocks?: string
  /** Audita os mocks contra os schemas da spec na subida. Só reporta. */
  checkMocks?: boolean
}
