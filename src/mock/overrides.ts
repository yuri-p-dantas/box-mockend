import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { RouteDefinition } from '../types.js'

/**
 * Mocks por arquivo.
 *
 * A OpenAPI é o contrato — o que existe, com que método e que status. O mock é
 * o dado que o frontend quer receber. Por isso o arquivo contém **apenas o
 * corpo**: nada da spec é reescrito, e um mock nunca cria uma rota.
 *
 * A rota é identificada pelo **caminho do arquivo**, que espelha a URL:
 *
 *   GET /v1/cart/{cart_id}/shipping  →  mocks/v1/cart/[cart_id]/shipping/GET.json
 */

/** Caminho onde o mock desta rota deve estar, exista o arquivo ou não. */
export function mockFilePath(mocksDir: string, route: RouteDefinition): string {
  const segments = route.fastifyPath
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `[${segment.slice(1)}]` : segment))

  return join(mocksDir, ...segments, `${route.method}.json`)
}

/**
 * Lê o mock de uma rota, se houver.
 *
 * A leitura acontece a cada requisição de propósito: editar o JSON e recarregar
 * a tela passa a bastar, sem reiniciar o Mockend e sem uma linha de watcher.
 * Arquivo ausente devolve `undefined` — apagar o mock volta a gerar pelo
 * contrato. JSON inválido lança, para o servidor poder apontar o arquivo em vez
 * de cair em silêncio para o dado gerado.
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
  /** Rotas com `mockFile` preenchido. */
  routes: RouteDefinition[]
  /** Arquivos que não correspondem a nenhuma rota, e quantos mocks foram encontrados. */
  warnings: string[]
  found: number
}

/**
 * Associa cada rota ao seu arquivo de mock e denuncia arquivos órfãos.
 *
 * O aviso de órfão é o que evita o pior modo de falha desta funcionalidade:
 * criar o mock, ele não ser aplicado, e não haver nenhuma pista do motivo.
 */
export async function resolveMocks(
  routes: RouteDefinition[],
  mocksDir: string,
): Promise<ResolveMocksResult> {
  const withMockFile = routes.map((route) => ({ ...route, mockFile: mockFilePath(mocksDir, route) }))
  const expected = new Set(withMockFile.map((route) => route.mockFile))
  const warnings: string[] = []

  let files: string[] = []
  try {
    files = await listJsonFiles(mocksDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { routes: withMockFile, warnings, found: 0 }
  }

  for (const file of files.filter((file) => !expected.has(file))) {
    warnings.push(
      `mock "${relative(mocksDir, file)}" não corresponde a nenhuma rota da spec e será ignorado ` +
        `(o caminho deve espelhar a URL, com o método como nome do arquivo: v1/product/list${sep}GET.json)`,
    )
  }

  return { routes: withMockFile, warnings, found: files.length - warnings.length }
}
