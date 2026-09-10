import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { parseHttpStatus, type RouteDefinition, type SchemaNode } from '../types.js'
import { resolveSchema } from './generate.js'
import { selectResponse } from './select-response.js'

/**
 * Mocks por arquivo.
 *
 * A OpenAPI é o contrato — o que existe, com que método e que status. O mock é
 * o dado que o frontend quer receber. Por isso o arquivo contém **apenas o
 * corpo**: nada da spec é reescrito, e um mock nunca cria uma rota.
 *
 * A rota é identificada pelo **caminho do arquivo**, que espelha a URL, e o
 * método é o último segmento. Duas formas convivem:
 *
 *   GET /v1/product/list  →  mocks/v1/product/list/GET.json        (resposta padrão)
 *   GET /order/{id}       →  mocks/order/[id]/GET/200.json         (uma por status)
 *                            mocks/order/[id]/GET/400.json
 *
 * A forma de arquivo único atende o caso comum, que é resposta única; a de
 * diretório entra quando a rota precisa de mais de um cenário.
 */

/** Base dos mocks desta rota, sem extensão: `.../v1/product/list/GET`. */
export function mockBasePath(mocksDir: string, route: RouteDefinition): string {
  const segments = route.fastifyPath
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `[${segment.slice(1)}]` : segment))

  return join(mocksDir, ...segments, route.method)
}

/** `<base>.json` — a resposta padrão da rota. */
export function singleMockFile(base: string): string {
  return `${base}.json`
}

/** `<base>/<status>.json` — o cenário daquele status. */
export function statusMockFile(base: string, status: number): string {
  return join(base, `${status}.json`)
}

/**
 * Lê o mock de uma rota, se houver.
 *
 * A leitura acontece a cada requisição de propósito: editar o JSON e recarregar
 * a tela passa a bastar, sem reiniciar o Mockend e sem uma linha de watcher.
 * Arquivo ausente devolve `undefined` — apagar o mock volta a gerar pelo
 * contrato. JSON inválido lança, para quem chamou poder apontar o arquivo em
 * vez de cair em silêncio para o dado gerado.
 */
export async function readMock(file: string): Promise<unknown> {
  let content: string

  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  return JSON.parse(content)
}

export interface MockLookup {
  /** Arquivo que casou. Ausente significa que não há mock para este status. */
  file?: string
  /** Conteúdo, quando o arquivo existe e é JSON válido. */
  body?: unknown
  /** Mensagem de parsing, quando o arquivo existe mas está quebrado. */
  error?: string
}

/**
 * Localiza e lê o mock aplicável a um status.
 *
 * Ordem: `<base>/<status>.json` sempre; `<base>.json` apenas quando o status
 * pedido é o padrão da rota. A condição importa — `<base>.json` significa "o
 * corpo da resposta padrão", e servi-lo com status 400 entregaria o corpo de
 * sucesso sob um status de erro.
 */
export async function lookupMock(
  base: string,
  status: number,
  allowSingleFile: boolean,
): Promise<MockLookup> {
  const candidates = allowSingleFile
    ? [statusMockFile(base, status), singleMockFile(base)]
    : [statusMockFile(base, status)]

  for (const file of candidates) {
    try {
      const body = await readMock(file)
      if (body !== undefined) return { file, body }
    } catch (error) {
      return { file, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {}
}

/** Status que têm arquivo de cenário hoje, em ordem crescente. */
export async function listMockStatuses(base: string): Promise<number[]> {
  let entries: string[]

  try {
    entries = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseHttpStatus(basename(name, '.json')))
    .filter((status): status is number => status !== null)
    .sort((a, b) => a - b)
}

/**
 * Recursão explícita em vez de `readdir({ recursive: true })`: a propriedade do
 * `Dirent` que aponta o diretório mudou de nome entre versões do Node (`path`
 * até a 20.11, `parentPath` depois), e não vale amarrar o projeto a isso.
 */
async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) files.push(...(await listJsonFiles(path)))
    else if (entry.name.endsWith('.json')) files.push(path)
  }

  return files
}

export interface ResolveMocksResult {
  /** Rotas com `mockBase` preenchido. */
  routes: RouteDefinition[]
  /** Arquivos órfãos e conflitos entre as duas formas. */
  warnings: string[]
  /** Quantos arquivos casaram com alguma rota. */
  found: number
}

/** Status que a rota devolve quando ninguém pede outro. */
function defaultStatusOf(route: RouteDefinition): number | undefined {
  return selectResponse(route.responses)?.statusCode
}

/**
 * Associa cada rota à sua base de mocks e denuncia arquivos que não serão usados.
 *
 * O aviso de órfão evita o pior modo de falha desta funcionalidade: criar o
 * mock, ele não ser aplicado, e não haver nenhuma pista do motivo. Como agora
 * aceitamos status que a spec não declara, a validade de um arquivo é
 * estrutural (está no lugar certo, com nome de status válido?) e não uma
 * comparação com uma lista fechada de caminhos.
 */
export async function resolveMocks(
  routes: RouteDefinition[],
  mocksDir: string,
): Promise<ResolveMocksResult> {
  const withBase = routes.map((route) => ({ ...route, mockBase: mockBasePath(mocksDir, route) }))
  const warnings: string[] = []

  const singles = new Set(withBase.map((route) => singleMockFile(route.mockBase)))
  const directories = new Set(withBase.map((route) => route.mockBase))

  let files: string[] = []
  try {
    files = await listJsonFiles(mocksDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { routes: withBase, warnings, found: 0 }
  }

  const present = new Set(files)
  let found = 0

  for (const file of files) {
    const shown = relative(mocksDir, file)

    if (singles.has(file)) {
      found += 1
      continue
    }

    if (directories.has(dirname(file))) {
      const name = basename(file, '.json')

      if (parseHttpStatus(name) === null) {
        warnings.push(
          `mock "${shown}" será ignorado: dentro da pasta de um método, o nome do arquivo ` +
            'deve ser um status HTTP entre 100 e 599, como "200.json" ou "400.json"',
        )
        continue
      }

      found += 1
      continue
    }

    warnings.push(
      `mock "${shown}" não corresponde a nenhuma rota da spec e será ignorado ` +
        '(o caminho deve espelhar a URL, com o método como nome do arquivo — ' +
        'v1/product/list/GET.json — ou como pasta, para cenários por status — ' +
        'order/[order_id]/GET/400.json)',
    )
  }

  // Conflito real: os dois formatos disputando o mesmo status. As demais
  // combinações (por exemplo GET.json + GET/400.json) são uso misto legítimo.
  for (const route of withBase) {
    const status = defaultStatusOf(route)
    if (status === undefined) continue

    if (present.has(singleMockFile(route.mockBase)) && present.has(statusMockFile(route.mockBase, status))) {
      warnings.push(
        `${route.method} ${route.fastifyPath}: existem "${relative(mocksDir, singleMockFile(route.mockBase))}" e ` +
          `"${relative(mocksDir, statusMockFile(route.mockBase, status))}" para o mesmo status ${status}; ` +
          'a pasta vence e o arquivo único é ignorado',
      )
    }
  }

  return { routes: withBase, warnings, found }
}

/** Divergência entre um mock e o schema da resposta que ele substitui. */
export interface MockContractIssue {
  /** `GET /v1/product/list` */
  route: string
  /** Status que este arquivo de mock representa. */
  status: number
  /** Caminho do arquivo, relativo ao diretório de mocks. */
  file: string
  /** Caminhos como `data[].badge`, na ordem em que aparecem no mock. */
  fields: string[]
  /** A spec não declara este status — o mock está adicionando contrato. */
  undeclaredStatus?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coleta os caminhos do mock que o schema não declara.
 *
 * Só compara nomes de propriedade — não valida tipo, formato nem obrigatoriedade.
 * Schema sem `properties` (objeto livre) não gera achado: não há o que comparar.
 *
 * Limitação: `oneOf`/`anyOf` são resolvidos pelo primeiro ramo, igual ao
 * gerador, então um campo válido só no segundo ramo apareceria como divergência.
 */
function collectUnknownFields(
  value: unknown,
  schema: SchemaNode | null,
  path: string,
  found: Set<string>,
): void {
  const resolved = resolveSchema(schema)
  if (!resolved) return

  if (Array.isArray(value)) {
    // Todos os itens, não só o primeiro: elementos diferentes podem trazer
    // campos diferentes. O Set cuida da repetição.
    for (const item of value) collectUnknownFields(item, resolved.items ?? null, `${path}[]`, found)
    return
  }

  if (!isPlainObject(value)) return

  const properties = resolved.properties
  if (!properties || Object.keys(properties).length === 0) return

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key

    if (key in properties) collectUnknownFields(child, properties[key] ?? null, childPath, found)
    else found.add(childPath)
  }
}

/** Os arquivos de mock que existem hoje para uma rota, com o status de cada um. */
async function listRouteMocks(
  route: RouteDefinition,
): Promise<{ status: number; file: string }[]> {
  if (!route.mockBase) return []

  const entries: { status: number; file: string }[] = []
  const status = defaultStatusOf(route)

  if (status !== undefined) {
    const single = singleMockFile(route.mockBase)
    if ((await readMock(single).catch(() => undefined)) !== undefined) {
      entries.push({ status, file: single })
    }
  }

  for (const found of await listMockStatuses(route.mockBase)) {
    entries.push({ status: found, file: statusMockFile(route.mockBase, found) })
  }

  return entries
}

/**
 * Compara cada mock com o schema da resposta que ele substitui.
 *
 * É auditoria, não validação: nada aqui impede o servidor de subir nem o mock de
 * ser servido. Reporta duas coisas: campo fora do schema — que costuma
 * significar que a OpenAPI está atrasada em relação ao que o backend já devolve
 * — e status que a spec não documenta, que é o mock adicionando contrato.
 */
export async function checkMocks(
  routes: RouteDefinition[],
  mocksDir?: string,
): Promise<MockContractIssue[]> {
  const issues: MockContractIssue[] = []

  for (const route of routes) {
    for (const { status, file } of await listRouteMocks(route)) {
      const shown = mocksDir ? relative(mocksDir, file) : file
      const label = `${route.method} ${route.fastifyPath}`

      let mock: unknown
      try {
        mock = await readMock(file)
      } catch {
        // JSON inválido já é reportado na requisição, com o arquivo nomeado.
        continue
      }

      const response = selectResponse(route.responses, status)

      if (!response) {
        issues.push({ route: label, status, file: shown, fields: [], undeclaredStatus: true })
        continue
      }

      if (!response.schema) continue

      const found = new Set<string>()
      collectUnknownFields(mock, response.schema, '', found)

      if (found.size > 0) issues.push({ route: label, status, file: shown, fields: [...found] })
    }
  }

  return issues
}
