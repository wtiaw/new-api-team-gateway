/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type ImportClient = 'cc-switch' | 'magpie'
export type ImportApp = 'codex' | 'claude' | 'gemini'

export function gatewayImportBase(address: string): string {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    throw new Error(
      'A valid HTTPS gateway address is required for client import'
    )
  }
  const host = url.hostname
  const privateIPv4 =
    /^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  const local =
    host === 'localhost' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    privateIPv4
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    /[?#]/.test(url.href)
  ) {
    throw new Error(
      'A valid HTTPS gateway address is required for client import'
    )
  }
  return url
    .toString()
    .replace(/\/+$/, '')
    .replace(/\/(v1|v1beta)$/, '')
}

export function buildClientImportURL(options: {
  client: ImportClient
  app: ImportApp
  address: string
  name: string
  key: string
  models: Record<string, string>
}): string {
  const base = gatewayImportBase(options.address)
  const name = options.name.trim()
  if (!name || name.length > 80) {
    throw new Error('Enter a name of 1 to 80 characters')
  }
  if (
    !options.key ||
    options.key === 'sk-' ||
    /[\s*\u2022]/u.test(options.key)
  ) {
    throw new Error('The full API key could not be retrieved')
  }
  const key = options.key.startsWith('sk-') ? options.key : `sk-${options.key}`
  if (options.client === 'magpie') {
    // Omitting models lets Magpie discover the current key's authorized models.
    const params = new URLSearchParams({
      name,
      key,
      chat: `${base}/v1`,
      responses: `${base}/v1`,
      anthropic: base,
      gemini: `${base}/v1beta`,
    })
    return `magpie://import?${params.toString()}`
  }
  const params = new URLSearchParams({
    resource: 'provider',
    app: options.app,
    name,
    apiKey: key,
    endpoint: options.app === 'codex' ? `${base}/v1` : base,
    apiFormat: {
      codex: 'openai_responses',
      claude: 'anthropic',
      gemini: 'gemini_native',
    }[options.app],
    homepage: base,
  })
  for (const field of ['model', 'haikuModel', 'sonnetModel', 'opusModel']) {
    const model = options.models[field]?.trim()
    if (model && (field === 'model' || options.app === 'claude')) {
      params.set(field, model)
    }
  }
  return `ccswitch://v1/import?${params.toString()}`
}
