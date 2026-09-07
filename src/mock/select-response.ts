import type { MockResponse } from '../types.js'

/**
 * Escolhe qual resposta da spec devolver.
 *
 * Regra: a menor 2xx declarada. Sem 2xx, a menor resposta declarada — uma
 * operação que só documenta 404 devolve 404. Sem nenhuma resposta, `null`,
 * e cabe ao servidor sinalizar que não consegue mockar a operação.
 *
 * As respostas chegam ordenadas por status pelo normalizer.
 */
export function selectResponse(responses: MockResponse[]): MockResponse | null {
  if (responses.length === 0) return null

  const success = responses.find(
    (response) => response.statusCode >= 200 && response.statusCode < 300,
  )

  return success ?? responses[0]
}
