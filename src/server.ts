import { relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { buildBody } from './mock/generate.js'
import { listMockStatuses, lookupMock, statusMockFile } from './mock/overrides.js'
import { selectResponse } from './mock/select-response.js'
import { parseHttpStatus, type MockendConfig, type RouteDefinition } from './types.js'

/**
 * Erros do próprio Mockend nunca podem ser confundidos com uma resposta
 * mockada da API. Todos saem com este envelope e com o header `x-mockend-error`.
 */
function sendMockendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
  hint: string,
): FastifyReply {
  return reply.code(statusCode).header('x-mockend-error', 'true').send({ error, message, hint })
}

/**
 * Lê `Prefer: code=<status>` (RFC 7240).
 *
 * Header padrão em vez de um `x-mockend-status` inventado, e a mesma sintaxe do
 * Prism. Outras preferências na mesma linha são ignoradas, como manda o RFC.
 */
function parsePreferCode(
  header: string | string[] | undefined,
): { status: number } | { invalid: string } | undefined {
  if (!header) return undefined

  const raw = Array.isArray(header) ? header.join(',') : header
  const match = /(?:^|[,;\s])code\s*=\s*"?([^",;\s]+)"?/i.exec(raw)
  if (!match) return undefined

  const status = parseHttpStatus(match[1])

  return status === null ? { invalid: match[1] } : { status }
}

/** Status que a rota sabe produzir: os da spec mais os que têm arquivo de mock. */
async function availableStatuses(route: RouteDefinition): Promise<number[]> {
  const fromSpec = route.responses.map((response) => response.statusCode)
  const fromMocks = route.mockBase ? await listMockStatuses(route.mockBase) : []

  return [...new Set([...fromSpec, ...fromMocks])].sort((a, b) => a - b)
}

function makeHandler(route: RouteDefinition, config: Pick<MockendConfig, 'delay'>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.delay > 0) await delay(config.delay)

    const prefer = parsePreferCode(request.headers.prefer)

    if (prefer && 'invalid' in prefer) {
      return sendMockendError(
        reply,
        400,
        'MOCKEND_INVALID_PREFER',
        `"Prefer: code=${prefer.invalid}" não é um status HTTP válido.`,
        'Use três dígitos entre 100 e 599, por exemplo "Prefer: code=400".',
      )
    }

    const requested = prefer?.status
    const fallback = selectResponse(route.responses)
    const status = requested ?? fallback?.statusCode

    if (status === undefined) {
      return sendMockendError(
        reply,
        501,
        'MOCKEND_NO_RESPONSE_DEFINED',
        `A operação ${route.method} ${route.openapiPath} não declara nenhuma resposta na spec.`,
        'Adicione uma resposta ao contrato para que o Mockend consiga mocká-la.',
      )
    }

    // `<base>.json` só vale para o status padrão: ele é o corpo da resposta
    // padrão, e servi-lo sob um status de erro seria silenciosamente errado.
    const isDefaultStatus = requested === undefined || requested === fallback?.statusCode
    const lookup = route.mockBase ? await lookupMock(route.mockBase, status, isDefaultStatus) : {}

    if (lookup.error) {
      return sendMockendError(
        reply,
        500,
        'MOCKEND_INVALID_MOCK',
        `Não foi possível ler o mock ${lookup.file}: ${lookup.error}`,
        'Corrija o JSON do arquivo. Apagar o arquivo volta a gerar a resposta pelo contrato.',
      )
    }

    const declared = selectResponse(route.responses, status)

    // Pediram um status que nem a spec declara nem um mock fornece. Cair para o
    // 200 aqui seria o pior desfecho possível: a tela mostraria sucesso e você
    // concluiria que o tratamento de erro funciona sem nunca tê-lo exercitado.
    if (!declared && lookup.file === undefined) {
      const disponiveis = await availableStatuses(route)

      return sendMockendError(
        reply,
        400,
        'MOCKEND_NO_MOCK_FOR_STATUS',
        `${route.method} ${route.openapiPath} não sabe responder com status ${status}: ` +
          `a spec não o declara e não há mock para ele. Status disponíveis: ${disponiveis.join(', ') || 'nenhum'}.`,
        `Crie ${route.mockBase ? relative(process.cwd(), statusMockFile(route.mockBase, status)) : `um mock ${status}.json`} para simular esse cenário.`,
      )
    }

    const response = declared ?? {
      statusCode: status,
      contentType: 'application/json',
      schema: null,
      example: undefined,
    }

    const body = buildBody(response, lookup.body)

    reply.code(response.statusCode)
    if (response.contentType) reply.header('content-type', response.contentType)

    return body === undefined ? reply.send() : reply.send(body)
  }
}

/** Cria o servidor a partir das rotas. Não conhece OpenAPI — só `RouteDefinition`. */
export async function createServer(
  routes: RouteDefinition[],
  config: Pick<MockendConfig, 'delay'>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cors, { origin: true, credentials: true })

  for (const route of routes) {
    app.route({ method: route.method, url: route.fastifyPath, handler: makeHandler(route, config) })
  }

  app.setNotFoundHandler((request, reply) =>
    sendMockendError(
      reply,
      404,
      'MOCKEND_ROUTE_NOT_FOUND',
      `A rota ${request.method} ${request.url} não existe na spec carregada.`,
      'Confira o path na OpenAPI ou aponte --spec para o contrato correto.',
    ),
  )

  app.setErrorHandler((error: unknown, request, reply) =>
    sendMockendError(
      reply,
      500,
      'MOCKEND_INTERNAL_ERROR',
      `Falha ao mockar ${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`,
      'Provavelmente é um caso do contrato que o Mockend ainda não trata. Registre o path e o schema.',
    ),
  )

  return app
}
