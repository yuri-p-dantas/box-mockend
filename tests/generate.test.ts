import { describe, expect, it } from 'vitest'
import { buildBody, generate } from '../src/mock/generate.js'
import type { SchemaNode } from '../src/types.js'

describe('precedência do contrato', () => {
  it('usa o example da resposta antes de olhar o schema', () => {
    const body = buildBody({
      contentType: 'application/json',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      example: { name: 'do example' },
    })

    expect(body).toEqual({ name: 'do example' })
  })

  it('usa o example do schema quando a resposta não tem example', () => {
    const body = buildBody({
      contentType: 'application/json',
      schema: { type: 'object', example: { brand: 'Animale' }, properties: { brand: { type: 'string' } } },
      example: undefined,
    })

    expect(body).toEqual({ brand: 'Animale' })
  })

  it('usa o primeiro valor do enum antes de gerar por type', () => {
    expect(generate({ type: 'string', enum: ['invoice', 'voucher'] })).toBe('invoice')
  })

  it('aplica a precedência em cada nó, não só na raiz', () => {
    const schema: SchemaNode = {
      type: 'object',
      properties: {
        acquirer: { type: 'string', example: 'Cielo' },
        status: { type: 'string', enum: ['approved', 'denied'] },
        plain: { type: 'string' },
      },
    }

    expect(generate(schema)).toEqual({ acquirer: 'Cielo', status: 'approved', plain: 'string' })
  })

  it('devolve undefined quando a resposta não declara corpo', () => {
    expect(buildBody({ contentType: null, schema: null, example: undefined })).toBeUndefined()
  })
})

describe('geração por type', () => {
  it('cobre os tipos primitivos', () => {
    expect(generate({ type: 'string' })).toBe('string')
    expect(generate({ type: 'integer' })).toBe(0)
    expect(generate({ type: 'number' })).toBe(0)
    expect(generate({ type: 'boolean' })).toBe(true)
    expect(generate({ type: 'null' })).toBeNull()
  })

  it('respeita minimum em números', () => {
    expect(generate({ type: 'integer', minimum: 10 })).toBe(10)
  })

  it('usa valores fixos por format, mantendo a geração determinística', () => {
    expect(generate({ type: 'string', format: 'date-time' })).toBe('2024-01-01T00:00:00.000Z')
    expect(generate({ type: 'string', format: 'uuid' })).toBe('00000000-0000-4000-8000-000000000000')
    expect(generate({ type: 'string', format: 'email' })).toBe('user@example.com')
  })

  it('gera o mesmo resultado em chamadas repetidas', () => {
    const schema: SchemaNode = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } }
    expect(generate(schema)).toEqual(generate(schema))
  })
})

describe('arrays', () => {
  it('gera 3 itens por padrão', () => {
    expect(generate({ type: 'array', items: { type: 'string' } })).toEqual(['string', 'string', 'string'])
  })

  it('respeita minItems maior que o padrão', () => {
    const result = generate({ type: 'array', minItems: 5, items: { type: 'integer' } }) as unknown[]
    expect(result).toHaveLength(5)
  })

  it('respeita maxItems menor que o padrão', () => {
    const result = generate({ type: 'array', maxItems: 1, items: { type: 'integer' } }) as unknown[]
    expect(result).toHaveLength(1)
  })

  it('devolve array vazio quando items não é declarado', () => {
    expect(generate({ type: 'array' })).toEqual([])
  })
})

describe('composição', () => {
  it('achata allOf combinando as properties', () => {
    const schema: SchemaNode = {
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } } },
        { type: 'object', properties: { extra: { type: 'boolean' } } },
      ],
    }

    expect(generate(schema)).toEqual({ id: 0, extra: true })
  })

  it('achata allOf aninhado', () => {
    const schema: SchemaNode = {
      allOf: [
        { allOf: [{ type: 'object', properties: { deep: { type: 'string' } } }] },
        { type: 'object', properties: { shallow: { type: 'integer' } } },
      ],
    }

    expect(generate(schema)).toEqual({ deep: 'string', shallow: 0 })
  })

  it('escolhe o primeiro ramo de oneOf e de anyOf', () => {
    expect(generate({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toBe('string')
    expect(generate({ anyOf: [{ type: 'boolean' }, { type: 'string' }] })).toBe(true)
  })
})

describe('inferência e casos degenerados', () => {
  it('infere object a partir de properties quando type está ausente', () => {
    expect(generate({ properties: { inner: { type: 'integer' } } })).toEqual({ inner: 0 })
  })

  it('infere array a partir de items quando type está ausente', () => {
    expect(generate({ items: { type: 'boolean' } })).toEqual([true, true, true])
  })

  it('trata object sem properties como objeto vazio', () => {
    expect(generate({ type: 'object' })).toEqual({})
  })

  it('devolve null para tipo desconhecido, como o "file" herdado de Swagger 2.0', () => {
    expect(generate({ type: 'file' })).toBeNull()
  })

  it('tolera schema null e undefined', () => {
    expect(generate(null)).toBeNull()
    expect(generate(undefined)).toBeNull()
  })

  it('tolera propriedade com schema null, como sobra de $ref quebrado', () => {
    expect(generate({ type: 'object', properties: { address: null } })).toEqual({ address: null })
  })

  it('usa o primeiro tipo não-null quando type é um array (OpenAPI 3.1)', () => {
    expect(generate({ type: ['null', 'integer'] })).toBe(0)
  })
})

describe('profundidade', () => {
  it('não entra em laço infinito com schema recursivo', () => {
    const node: SchemaNode = { type: 'object', properties: { label: { type: 'string' } } }
    node.properties!.child = node

    const result = generate(node, 3) as Record<string, unknown>

    expect(result.label).toBe('string')
    expect(JSON.stringify(result)).toContain('"child":null')
  })

  it('corta exatamente na profundidade configurada', () => {
    const node: SchemaNode = { type: 'object', properties: {} }
    node.properties!.child = node

    expect(generate(node, 0)).toEqual({ child: null })
  })
})
