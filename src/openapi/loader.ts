import { $RefParser } from '@apidevtools/json-schema-ref-parser'

export interface OpenApiDocument {
  openapi?: string
  swagger?: string
  paths?: Record<string, unknown>
  [key: string]: unknown
}

export interface LoadedSpec {
  document: OpenApiDocument
  warnings: string[]
}

/** `JSONParserErrorGroup` expõe os erros individuais em `.errors`. */
function isParserErrorGroup(error: unknown): error is { errors: Array<{ message?: string }> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { errors?: unknown }).errors)
  )
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim()
}

/**
 * Carrega uma spec OpenAPI (JSON ou YAML) e resolve todos os `$ref`.
 *
 * `$ref` quebrado não derruba o boot: o documento parcialmente resolvido
 * continua utilizável (o nó não resolvido vira `null`) e o problema volta como
 * warning. Qualquer outra falha de parsing derruba o processo — carregar uma
 * spec pela metade em silêncio seria pior do que não subir.
 */
export async function loadSpec(specPath: string): Promise<LoadedSpec> {
  const parser = new $RefParser()
  const warnings: string[] = []

  let document: OpenApiDocument | undefined

  try {
    document = (await parser.dereference(specPath, {
      continueOnError: true,
    })) as OpenApiDocument
  } catch (error) {
    if (!isParserErrorGroup(error)) throw error

    for (const parserError of error.errors) {
      warnings.push(`referência não resolvida: ${firstLine(parserError.message ?? String(parserError))}`)
    }

    document = parser.schema as OpenApiDocument | undefined
  }

  if (!document || typeof document !== 'object') {
    throw new Error(`não foi possível carregar a spec: ${specPath}`)
  }

  if (!document.paths || typeof document.paths !== 'object') {
    throw new Error(`a spec não tem um objeto "paths": ${specPath}`)
  }

  if (document.swagger && !document.openapi) {
    warnings.push('spec em Swagger 2.0; o Mockend foi feito para OpenAPI 3.x e pode ignorar partes do contrato')
  }

  return { document, warnings }
}
