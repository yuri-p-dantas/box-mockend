import { describe, expect, it } from 'vitest'
import { selectResponse } from '../src/mock/select-response.js'
import type { MockResponse } from '../src/types.js'

const response = (statusCode: number): MockResponse => ({
  statusCode,
  contentType: 'application/json',
  schema: null,
  example: undefined,
})

describe('selectResponse', () => {
  it('escolhe a menor 2xx', () => {
    expect(selectResponse([response(200), response(202), response(400)])?.statusCode).toBe(200)
    expect(selectResponse([response(202), response(204), response(500)])?.statusCode).toBe(202)
  })

  it('ignora status fora da faixa 2xx mesmo quando são menores', () => {
    expect(selectResponse([response(201), response(400)])?.statusCode).toBe(201)
  })

  it('cai para a menor resposta declarada quando não há 2xx', () => {
    expect(selectResponse([response(404), response(500)])?.statusCode).toBe(404)
  })

  it('devolve null quando a operação não declara nenhuma resposta', () => {
    expect(selectResponse([])).toBeNull()
  })
})
