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
import { describe, expect, it } from 'vitest'

import { buildClientImportURL, gatewayImportBase } from '../client-import'

const options = {
  client: 'cc-switch' as const,
  app: 'codex' as const,
  address: 'https://gateway.example/proxy/v1/',
  name: '开发 & 测试',
  key: 'fixture&+#?',
  models: { model: 'gpt-5.4' },
}

describe('client import protocols', () => {
  it.each([
    'https://gateway.example/proxy',
    'https://gateway.example/proxy/',
    'https://gateway.example/proxy/v1/',
    'https://gateway.example/proxy/v1beta',
  ])('normalizes %s and preserves gateway subpaths', (address) => {
    expect(gatewayImportBase(address)).toBe('https://gateway.example/proxy')
  })
  it.each([
    'javascript:alert(1)',
    'http://gateway.example',
    'http://10.evil.example',
    'https://gateway.example/?',
    'https://gateway.example/#',
    'https://user:secret@gateway.example',
    'https://gateway.example?key=x',
    'https://gateway.example/#x',
    'invalid',
  ])('rejects an unsafe or ambiguous address %s', (address) => {
    expect(() => buildClientImportURL({ ...options, address })).toThrow(
      'HTTPS gateway address'
    )
  })
  it('allows local development endpoints', () => {
    expect(gatewayImportBase('http://localhost:18310/v1')).toBe(
      'http://localhost:18310'
    )
  })
  it.each([
    ['codex', '/v1', 'openai_responses'],
    ['claude', '', 'anthropic'],
    ['gemini', '', 'gemini_native'],
  ] as const)(
    'builds a CC Switch %s import with explicit format and user-controlled activation',
    (app, suffix, format) => {
      const url = new URL(buildClientImportURL({ ...options, app }))
      expect(url.protocol).toBe('ccswitch:')
      expect(url.hostname).toBe('v1')
      expect(url.pathname).toBe('/import')
      expect(url.searchParams.get('apiKey')).toBe('sk-fixture&+#?')
      expect(url.searchParams.get('name')).toBe('开发 & 测试')
      expect(url.searchParams.get('endpoint')).toBe(
        `https://gateway.example/proxy${suffix}`
      )
      expect(url.searchParams.get('apiFormat')).toBe(format)
      expect(url.searchParams.get('model')).toBe('gpt-5.4')
      expect(url.searchParams.has('enabled')).toBe(false)
    }
  )
  it('uses native Magpie import with per-protocol endpoints and automatic model discovery', () => {
    const url = new URL(
      buildClientImportURL({
        ...options,
        client: 'magpie',
        key: 'sk-fixture&+#?',
      })
    )
    expect(url.protocol).toBe('magpie:')
    expect(url.hostname).toBe('import')
    expect(url.searchParams.get('key')).toBe('sk-fixture&+#?')
    expect(url.searchParams.get('chat')).toBe(
      'https://gateway.example/proxy/v1'
    )
    expect(url.searchParams.get('responses')).toBe(
      'https://gateway.example/proxy/v1'
    )
    expect(url.searchParams.get('anthropic')).toBe(
      'https://gateway.example/proxy'
    )
    expect(url.searchParams.get('gemini')).toBe(
      'https://gateway.example/proxy/v1beta'
    )
    expect(url.searchParams.has('models')).toBe(false)
  })
  it.each(['', 'masked***', 'has space', 'masked•••'])(
    'refuses missing or masked credentials',
    (key) => {
      expect(() => buildClientImportURL({ ...options, key })).toThrow(
        'full API key'
      )
    }
  )
  it.each([' ', 'x'.repeat(81)])('validates provider names', (name) => {
    expect(() => buildClientImportURL({ ...options, name })).toThrow('1 to 80')
  })
})
