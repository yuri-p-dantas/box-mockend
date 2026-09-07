import { setTimeout as delay } from 'node:timers/promises'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { buildBody } from './mock/generate.js'
import { selectResponse } from './mock/select-response.js'
import type { MockendConfig, RouteDefinition } from './types.js'

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

function makeHandler(route: RouteDefinition, config: Pick<MockendConfig, 'delay'>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.delay > 0) await delay(config.delay)

    const response = selectResponse(route.responses)

    if (!response) {
      return sendMockendError(
        reply,
        501,
        'MOCKEND_NO_RESPONSE_DEFINED',
        `A operação ${route.method} ${route.openapiPath} não declara nenhuma resposta na spec.`,
        'Adicione uma resposta ao contrato para que o Mockend consiga mocká-la.',
      )
    }

    const body = buildBody(response)

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
