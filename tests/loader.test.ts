import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSpec } from '../src/openapi/loader.js'

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures', name)
const SOMASTORE = resolve(import.meta.dirname, '..', 'examples', 'somastore-openapi.json')

describe('loadSpec', () => {
  it('carrega uma spec em YAML e resolve os $ref', async () => {
    const { document, warnings } = await loadSpec(fixture('minimal.yaml'))

    const schema = (document.paths as any)['/ping'].get.responses['200'].content['application/json'].schema

    expect(warnings).toEqual([])
    expect(schema.$ref).toBeUndefined()
    expect(schema.properties.ok.type).toBe('boolean')
  })

  it('carrega uma spec em JSON', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    expect(Object.keys(document.paths ?? {})).toContain('/composition')
  })

  it('resolve $ref aninhado dentro de allOf', async () => {
    const { document } = await loadSpec(fixture('edge-cases.json'))
    const merged = (document as any).components.schemas.Merged

    expect(merged.allOf[0].properties.id.type).toBe('integer')
  })

  it('rejeita arquivo inexistente', async () => {
    await expect(loadSpec(fixture('nao-existe.json'))).rejects.toThrow()
  })

  it('rejeita documento sem paths', async () => {
    await expect(loadSpec(resolve(import.meta.dirname, '..', 'package.json'))).rejects.toThrow(/paths/)
  })

  describe('spec real da Soma Store', () => {
    it('carrega apesar do $ref quebrado e reporta o problema como aviso', async () => {
      const { document, warnings } = await loadSpec(SOMASTORE)

      expect(Object.keys(document.paths ?? {})).toHaveLength(35)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('IFrameAddress')
    })

    it('deixa null no nó que não pôde ser resolvido e mantém o resto resolvido', async () => {
      const { document } = await loadSpec(SOMASTORE)
      const schemas = (document as any).components.schemas

      expect(schemas.IFrameCustomer.properties.address).toBeNull()
      expect(schemas.ManualIntegrationEditCharge.allOf[0].properties).toBeDefined()
    })
  })
})
