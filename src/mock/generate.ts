import type { SchemaNode } from '../types.js'

/** Itens gerados para um array sem `minItems`/`maxItems` definidos. */
const DEFAULT_ARRAY_LENGTH = 3

/**
 * Profundidade máxima da recursão.
 *
 * Existe para que schemas recursivos (`Category.parent: Category`) não travem o
 * processo. Abaixo do limite o gerador devolve `null` em vez de continuar.
 */
const DEFAULT_MAX_DEPTH = 6

/** Valores fixos por `format`: geração determinística, sem dependência de faker. */
const FORMAT_VALUES: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00.000Z',
  date: '2024-01-01',
  time: '00:00:00',
  uuid: '00000000-0000-4000-8000-000000000000',
  email: 'user@example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  uri: 'https://example.com',
  url: 'https://example.com',
  binary: '',
  byte: '',
  password: 'string',
}

function isSchema(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Achata `allOf` num único schema.
 *
 * Merge raso: `properties` são combinadas e o primeiro `type` encontrado vence.
 * Cobre o uso comum de `allOf` (composição de objetos) sem entrar em resolução
 * completa de JSON Schema.
 */
function flattenAllOf(schema: SchemaNode): SchemaNode {
  if (!Array.isArray(schema.allOf)) return schema

  const { allOf, ...rest } = schema
  const flattened: SchemaNode = { ...rest }
  const properties: Record<string, SchemaNode | null> = { ...(rest.properties ?? {}) }

  for (const part of allOf) {
    if (!isSchema(part)) continue

    const resolved = flattenAllOf(part)
    Object.assign(properties, resolved.properties ?? {})

    flattened.type ??= resolved.type
    flattened.example ??= resolved.example
    flattened.enum ??= resolved.enum
    flattened.items ??= resolved.items
  }

  if (Object.keys(properties).length > 0) flattened.properties = properties

  return flattened
}

/** `oneOf`/`anyOf`: o primeiro ramo válido, combinado com as palavras-chave irmãs. */
function resolveComposition(schema: SchemaNode): SchemaNode {
  const branches = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(branches)) return schema

  const branch = branches.find(isSchema)
  const { oneOf, anyOf, ...rest } = schema

  return branch ? { ...rest, ...branch } : rest
}

/**
 * Deduz o tipo quando a spec não declara `type` — comum em schemas de resposta
 * escritos inline.
 */
function inferType(schema: SchemaNode): string | undefined {
  const declared = Array.isArray(schema.type)
    ? schema.type.find((type) => type !== 'null')
    : schema.type

  if (typeof declared === 'string') return declared
  if (schema.properties) return 'object'
  if (schema.items) return 'array'

  return undefined
}

function arrayLength(schema: SchemaNode): number {
  const min = typeof schema.minItems === 'number' ? schema.minItems : 0
  const max = typeof schema.maxItems === 'number' ? schema.maxItems : Number.POSITIVE_INFINITY

  return Math.max(min, Math.min(DEFAULT_ARRAY_LENGTH, max))
}

function generateNode(schema: SchemaNode | null | undefined, depth: number, maxDepth: number): unknown {
  if (!isSchema(schema)) return null
  if (depth > maxDepth) return null

  const resolved = resolveComposition(flattenAllOf(schema))

  // Precedência do contrato, aplicada em todo nó — não só na raiz. É o que
  // aproveita os `example` declarados em propriedades individuais.
  if (resolved.example !== undefined) return resolved.example
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0]

  switch (inferType(resolved)) {
    case 'object': {
      const result: Record<string, unknown> = {}
      for (const [name, property] of Object.entries(resolved.properties ?? {})) {
        result[name] = generateNode(property, depth + 1, maxDepth)
      }
      return result
    }

    case 'array': {
      if (!isSchema(resolved.items)) return []
      const length = arrayLength(resolved)
      return Array.from({ length }, () => generateNode(resolved.items, depth + 1, maxDepth))
    }

    case 'string': {
      const format = typeof resolved.format === 'string' ? resolved.format : undefined
      if (format && format in FORMAT_VALUES) return FORMAT_VALUES[format]
      return 'string'
    }

    case 'integer':
    case 'number':
      return typeof resolved.minimum === 'number' ? resolved.minimum : 0

    case 'boolean':
      return true

    // Inclui `null`, tipos ausentes e tipos inválidos como o `type: "file"`
    // herdado de Swagger 2.0.
    default:
      return null
  }
}

/** Gera um corpo a partir de um schema já desreferenciado. */
export function generate(schema: SchemaNode | null | undefined, maxDepth = DEFAULT_MAX_DEPTH): unknown {
  return generateNode(schema, 0, maxDepth)
}

/**
 * Monta o corpo de uma resposta seguindo a precedência:
 * mock em arquivo → example da resposta → example do schema → enum → type.
 *
 * O mock ganha inclusive de um `example` declarado na spec: o que o
 * desenvolvedor escreveu à mão é deliberado, o exemplo do contrato é genérico.
 * Se fosse o contrário, o override deixaria de funcionar justamente nas rotas
 * que têm exemplo — o comportamento mais difícil de diagnosticar.
 *
 * O mock substitui o corpo inteiro; nunca há merge com o dado gerado.
 *
 * Os três últimos níveis são aplicados por `generate` em cada nó do schema.
 * Devolve `undefined` quando a spec não declara corpo para a resposta.
 */
export function buildBody(
  response: { contentType: string | null; schema: SchemaNode | null; example: unknown },
  mock?: unknown,
): unknown {
  if (mock !== undefined) return mock
  if (response.example !== undefined) return response.example
  if (response.contentType === null) return undefined

  return generate(response.schema)
}
