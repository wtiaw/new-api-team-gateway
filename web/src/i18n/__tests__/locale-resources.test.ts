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
import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import en from '../locales/en.json'
import fr from '../locales/fr.json'
import ja from '../locales/ja.json'
import ru from '../locales/ru.json'
import vi from '../locales/vi.json'
import zhTW from '../locales/zh-TW.json'
import zhCN from '../locales/zh.json'

const resources = { en, zhCN, zhTW, fr, ru, ja, vi }
const importKeys = [
  'Import to {{client}}',
  'Import this API key and gateway address into your client.',
  'Copy import link',
  'Open {{client}}',
  'Preparing import…',
  'Confirm the import in {{client}}',
  'Could not copy the import link',
  'Client import failed',
  'A valid HTTPS gateway address is required for client import',
  'Enter a name of 1 to 80 characters',
  'The full API key could not be retrieved',
  'Optional. Leave empty to use the client default model.',
  'Magpie discovers the models available to this key automatically.',
  'Install and open {{client}} first, then confirm the browser prompt. Import links contain your API key; keep them private.',
  'Download {{client}}',
  'Import {{name}} to {{client}}',
  'Key actions for {{name}}',
  'Quick import',
  'Key management',
]

describe('runtime locale resources', () => {
  it.each(Object.entries(resources))(
    'loads new client import copy through the %s translation namespace',
    async (language, resource) => {
      const instance = createInstance()
      await instance.init({
        lng: language,
        resources: { [language]: resource },
        initAsync: false,
        fallbackLng: false,
        nsSeparator: false,
      })
      for (const key of importKeys) {
        expect(instance.exists(key), `${language}: ${key}`).toBe(true)
      }
      expect(Object.keys(resource)).toEqual(['translation'])
    }
  )
})
