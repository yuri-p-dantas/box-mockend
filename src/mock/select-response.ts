import type { MockResponse } from '../types.js'

/**
 * Escolhe qual resposta da spec devolver.
 *
 * Sem `requestedStatus`: a menor 2xx declarada. Sem 2xx, a menor resposta
 * declarada — uma operação que só documenta 404 devolve 404. Sem nenhuma
 * resposta, `null`, e cabe ao servidor sinalizar que não consegue mockar.
 *
 * Com `requestedStatus` (vindo de `Prefer: code=`): exatamente aquele status,
 * ou `null` se a spec não o declarar. Aqui `null` não significa erro — um mock
 * em arquivo pode suprir um status que o contrato não documenta, e quem decide
 * isso é o servidor.
 *
 * As respostas chegam ordenadas por status pelo normalizer.
 */
export function selectResponse(
  responses: MockResponse[],
  requestedStatus?: number,
): MockResponse | null {
  if (requestedStatus !== undefined) {
    return responses.find((response) => response.statusCode === requestedStatus) ?? null
  }

  if (responses.length === 0) return null

  const success = responses.find(
    (response) => response.statusCode >= 200 && response.statusCode < 300,
  )

  return success ?? responses[0]
}
