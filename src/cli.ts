#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createMockend } from './index.js'
import type { MockContractIssue } from './mock/overrides.js'
import type { MockendConfig, RouteDefinition } from './types.js'

const DEFAULTS = { port: 4000, host: '0.0.0.0', delay: 0, mocks: './mocks' }

const USAGE = `
box-mockend — servidor HTTP de mock orientado por OpenAPI

  box-mockend --spec <caminho> [opções]

Opções
  --spec <caminho>   Spec OpenAPI 3.x em JSON ou YAML (obrigatório)
  --port <número>    Porta HTTP (padrão: ${DEFAULTS.port})
  --host <endereço>  Interface de bind (padrão: ${DEFAULTS.host})
  --delay <ms>       Atraso global aplicado antes de cada resposta (padrão: ${DEFAULTS.delay})
  --mocks <dir>      Diretório com mocks por rota (padrão: ${DEFAULTS.mocks}, se existir)
  --check-mocks      Compara os campos dos mocks com os schemas da spec e
                     reporta divergências na subida (só reporta; não bloqueia)
  --help             Mostra esta ajuda

Mocks por rota
  O caminho do arquivo espelha a URL e o método é o nome do arquivo. O conteúdo
  é apenas o corpo da resposta; status e content-type continuam vindo da spec.

    GET /v1/cart/{cart_id}/shipping  →  mocks/v1/cart/[cart_id]/shipping/GET.json

  Os arquivos são lidos a cada requisição: editar o JSON e recarregar a tela
  basta, sem reiniciar o Mockend.

Exemplo
  box-mockend --spec ./examples/somastore-openapi.json --port 4000 --delay 300
`.trim()

function fail(message: string): never {
  console.error(`box-mockend: ${message}`)
  process.exit(1)
}

function toPositiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${flag} precisa ser um inteiro não negativo (recebido: "${value}")`)

  return parsed
}

function parseConfig(): MockendConfig {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      delay: { type: 'string' },
      mocks: { type: 'string' },
      'check-mocks': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }

  if (!values.spec) fail(`--spec é obrigatório.\n\n${USAGE}`)

  const spec = resolve(values.spec)
  if (!existsSync(spec)) fail(`spec não encontrada: ${spec}`)

  return {
    spec,
    port: toPositiveInteger(values.port, DEFAULTS.port, '--port'),
    host: values.host ?? DEFAULTS.host,
    delay: toPositiveInteger(values.delay, DEFAULTS.delay, '--delay'),
    mocks: resolveMocksDir(values.mocks),
    checkMocks: values['check-mocks'],
  }
}

/**
 * `--mocks` explícito precisa existir — apontar para o lugar errado é quase
 * sempre erro de digitação, e falhar é melhor que ignorar em silêncio. Já o
 * `./mocks` implícito é opcional por natureza.
 */
function resolveMocksDir(value: string | undefined): string | undefined {
  if (value !== undefined) {
    const explicit = resolve(value)
    if (!existsSync(explicit)) fail(`diretório de mocks não encontrado: ${explicit}`)
    return explicit
  }

  const byConvention = resolve(DEFAULTS.mocks)
  return existsSync(byConvention) ? byConvention : undefined
}

function printRouteTable(routes: RouteDefinition[]): void {
  if (routes.length === 0) {
    console.log('Nenhuma rota encontrada na spec.')
    return
  }

  const methodWidth = Math.max(...routes.map((route) => route.method.length))
  const pathWidth = Math.max(...routes.map((route) => route.fastifyPath.length))

  const sorted = [...routes].sort(
    (a, b) => a.fastifyPath.localeCompare(b.fastifyPath) || a.method.localeCompare(b.method),
  )

  for (const route of sorted) {
    const statuses = route.responses.map((response) => response.statusCode).join(',') || '—'
    const mocked = route.mockFile && existsSync(route.mockFile) ? '  [mock]' : ''
    console.log(
      `  ${route.method.padEnd(methodWidth)}  ${route.fastifyPath.padEnd(pathWidth)}  ` +
        `${statuses}${route.operationId ? `  (${route.operationId})` : ''}${mocked}`,
    )
  }
}

/**
 * O cabeçalho explica uma vez que divergência não é sinônimo de erro no mock:
 * na prática a causa mais comum é a OpenAPI estar atrasada em relação ao que o
 * backend já devolve.
 */
function printMockIssues(issues: MockContractIssue[]): void {
  console.log('\nDivergências entre mocks e contrato:')

  if (issues.length === 0) {
    console.log('  nenhuma — todos os campos dos mocks estão declarados na spec')
    return
  }

  console.log(
    '  Campos declarados nos mocks que a OpenAPI não descreve. Pode ser campo que o\n' +
      '  backend real já devolve e o contrato ainda não documenta — não é necessariamente\n' +
      '  erro no mock. Só nomes de propriedade são comparados; tipos não são validados.\n',
  )

  for (const issue of issues) {
    console.log(`  [warning] ${issue.route}`)
    for (const field of issue.fields) {
      console.log(`      o mock declara "${field}", que não existe no schema da resposta`)
    }
  }
}

async function main(): Promise<void> {
  const config = parseConfig()
  const { server, routes, warnings, mocksFound, mockIssues } = await createMockend(config)

  console.log(`\nbox-mockend\n  spec: ${config.spec}`)
  if (config.mocks) console.log(`  mocks: ${config.mocks} (${mocksFound} encontrado(s))`)

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} aviso(s) sobre a spec:`)
    for (const warning of warnings) console.log(`  ! ${warning}`)
  }

  console.log(`\n${routes.length} rota(s) registrada(s):`)
  printRouteTable(routes)

  if (config.checkMocks) printMockIssues(mockIssues)

  await server.listen({ host: config.host, port: config.port })

  const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host
  console.log(`\nOuvindo em http://${displayHost}:${config.port}`)
  if (config.host === '0.0.0.0') {
    console.log('  (0.0.0.0 — acessível também por emulador Android e dispositivos na mesma rede)')
  }
  if (config.delay > 0) console.log(`  atraso global: ${config.delay}ms`)
  console.log()
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
