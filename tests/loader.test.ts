import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
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

  /**
   * A tolerância a `$ref` quebrado nasceu de um defeito real da spec da Soma
   * Store (`IFrameAddress`), que foi removido do arquivo depois. A cobertura
   * mudou para a fixture sintética, que reproduz o mesmo caso: sem isso, o
   * comportamento continuaria implementado e deixaria de ser exercitado.
   */
  describe('$ref quebrado', () => {
    let loaded: Awaited<ReturnType<typeof loadSpec>>

    beforeAll(async () => {
      loaded = await loadSpec(fixture('edge-cases.json'))
    })

    it('carrega a spec assim mesmo e reporta o problema como aviso', () => {
      expect(loaded.warnings).toHaveLength(1)
      expect(loaded.warnings[0]).toContain('DoesNotExist')
    })

    it('deixa null no nó que não pôde ser resolvido', () => {
      const schema = (loaded.document as any).paths['/broken-ref'].get.responses['200'].content[
        'application/json'
      ].schema

      expect(schema).toBeNull()
    })

    it('mantém o resto do documento resolvido', () => {
      const merged = (loaded.document as any).paths['/composition'].get.responses['200'].content[
        'application/json'
      ].schema.properties.merged

      expect(merged.allOf[0].properties.id.type).toBe('integer')
    })
  })

  describe('spec real da Soma Store', () => {
    let loaded: Awaited<ReturnType<typeof loadSpec>>

    beforeAll(async () => {
      loaded = await loadSpec(SOMASTORE)
    })

    it('carrega os 35 paths sem nenhum aviso de referência', () => {
      expect(Object.keys(loaded.document.paths ?? {})).toHaveLength(35)
      expect(loaded.warnings).toEqual([])
    })

    it('resolve os $ref usados pelas respostas', () => {
      const schemas = (loaded.document as any).components.schemas

      expect(schemas.ManualIntegrationEditCharge.allOf[0].properties).toBeDefined()
    })
  })
})
