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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import zhCN from '@/i18n/locales/zh.json'
import { getUserModels } from '@/lib/api'

import { fetchTokenKey } from '../../../api'
import { apiKeySchema } from '../../../types'
import { ClientImportDialog } from '../client-import-dialog'

vi.mock('@/hooks/use-status', () => ({
  useStatus: () => ({
    status: { server_address: 'https://gateway.example/v1/' },
  }),
}))
vi.mock('@/lib/api', () => ({
  getUserModels: vi.fn().mockResolvedValue({
    success: true,
    data: ['gpt-5.4', 'claude-sonnet-4-6'],
  }),
}))
vi.mock('../../../api', () => ({ fetchTokenKey: vi.fn() }))

const fixtureKey = apiKeySchema.parse({
  id: 7,
  name: 'Development',
  key: 'masked***',
  status: 1,
  group: 'development',
  remain_quota: 100,
  used_quota: 0,
  unlimited_quota: false,
  expired_time: -1,
  created_time: 0,
  accessed_time: 0,
  model_limits_enabled: false,
})

let queryClient: QueryClient

beforeEach(() => {
  vi.mocked(fetchTokenKey).mockResolvedValue({
    success: true,
    data: { key: 'fixture-only&+#?' },
  })
  vi.mocked(getUserModels).mockResolvedValue({
    success: true,
    data: ['gpt-5.4', 'claude-sonnet-4-6'],
  })
  vi.spyOn(window, 'open').mockImplementation(() => null)
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
})

afterEach(() => {
  queryClient.clear()
})

function renderDialog(models = ['gpt-5.4', 'claude-sonnet-4-6']) {
  queryClient.setQueryData(['user-models-client-import', 'development'], {
    success: true,
    data: models,
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ClientImportDialog
        open
        onOpenChange={vi.fn()}
        client='cc-switch'
        apiKey={fixtureKey}
      />
    </QueryClientProvider>
  )
}

describe('CC Switch model selection', () => {
  it.each(['Claude', 'Codex', 'Gemini'])(
    'opens %s models outside the clipping dialog and keeps the dialog open after selection',
    async (app) => {
      renderDialog()
      const user = userEvent.setup()
      await user.click(screen.getByRole('radio', { name: app }))
      const input = screen.getByRole('combobox', { name: 'Primary Model' })

      await user.click(input)

      expect(input).toHaveAttribute('aria-expanded', 'true')
      const list = await screen.findByRole('listbox')
      const dialog = screen.getByRole('dialog', { name: 'Import to CC Switch' })
      // The dialog is translated and clips overflow. Its popup must escape
      // that containing block to remain aligned and fully visible.
      expect(dialog).not.toContainElement(list)
      await user.click(screen.getByRole('option', { name: 'gpt-5.4' }))
      await waitFor(() => expect(input).toHaveValue('gpt-5.4'))
      expect(input).toHaveAttribute('aria-expanded', 'false')
      expect(dialog).toBeVisible()
    }
  )

  it('filters model names and supports keyboard selection and Escape without closing the dialog', async () => {
    renderDialog()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Codex' }))
    const input = screen.getByRole('combobox', { name: 'Primary Model' })
    await user.click(input)
    await user.type(input, 'sonnet')

    expect(
      screen.queryByRole('option', { name: 'gpt-5.4' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'claude-sonnet-4-6' })
    ).toBeVisible()
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(input).toHaveValue('claude-sonnet-4-6'))
    await user.click(input)
    await user.keyboard('{Escape}')

    expect(input).toHaveValue('claude-sonnet-4-6')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('shows an empty result when no models are available and updates an open dropdown when models arrive', async () => {
    vi.mocked(getUserModels).mockResolvedValue({ success: true, data: [] })
    renderDialog([])
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Codex' }))
    const input = screen.getByRole('combobox', { name: 'Primary Model' })
    await user.click(screen.getByRole('button', { name: 'Primary Model' }))

    expect(await screen.findByText('No models found')).toBeVisible()
    await act(async () => {
      queryClient.setQueryData(['user-models-client-import', 'development'], {
        success: true,
        data: ['gpt-5.4'],
      })
    })
    await user.click(await screen.findByRole('option', { name: 'gpt-5.4' }))
    await waitFor(() => expect(input).toHaveValue('gpt-5.4'))
  })

  it('lets users edit the provider name without opening a model dropdown', async () => {
    renderDialog()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'Name' })

    await user.clear(input)
    await user.type(input, 'Development')

    expect(input).toHaveValue('Development')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('client import credential handling', () => {
  it('retrieves an owned key only on explicit import and uses the selected group for model suggestions', async () => {
    renderDialog()
    expect(fetchTokenKey).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(getUserModels).toHaveBeenCalledWith('development')
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open CC Switch' })
    )
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce())
    expect(fetchTokenKey).toHaveBeenCalledWith(7)
    const url = new URL(vi.mocked(window.open).mock.calls[0][0] as string)
    expect(url.protocol).toBe('ccswitch:')
    expect(url.searchParams.get('apiKey')).toBe('sk-fixture-only&+#?')
    expect(url.searchParams.get('endpoint')).toBe('https://gateway.example/v1')
    expect(url.searchParams.get('app')).toBe('codex')
    expect(document.body.textContent).not.toContain('fixture-only')
  })

  it('does not launch after closing while the credential request is pending', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof fetchTokenKey>>) => void
    vi.mocked(fetchTokenKey).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    renderDialog()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open CC Switch' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () =>
      resolve({ success: true, data: { key: 'fixture-only' } })
    )
    expect(window.open).not.toHaveBeenCalled()
  })

  it('keeps the dialog available for retry after a denied credential request', async () => {
    vi.mocked(fetchTokenKey).mockResolvedValueOnce({
      success: false,
      message: 'Permission denied',
    })
    const error = vi.spyOn(toast, 'error')
    renderDialog()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open CC Switch' })
    )
    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open CC Switch' })).toBeEnabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open CC Switch' })
    )
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce())
    expect(fetchTokenKey).toHaveBeenCalledTimes(2)
  })

  it('filters model suggestions by the key restriction', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ClientImportDialog
          open
          onOpenChange={vi.fn()}
          client='cc-switch'
          apiKey={{
            ...fixtureKey,
            model_limits_enabled: true,
            model_limits: 'claude-sonnet-4-6',
          }}
        />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Primary Model' })
    )
    expect(
      await screen.findByRole('option', { name: 'claude-sonnet-4-6' })
    ).toBeVisible()
    expect(
      screen.queryByRole('option', { name: 'gpt-5.4' })
    ).not.toBeInTheDocument()
  })

  it('imports Magpie through its native protocol without requesting the account model list', async () => {
    vi.mocked(getUserModels).mockClear()
    render(
      <QueryClientProvider client={queryClient}>
        <ClientImportDialog
          open
          onOpenChange={vi.fn()}
          client='magpie'
          apiKey={fixtureKey}
        />
      </QueryClientProvider>
    )
    expect(fetchTokenKey).not.toHaveBeenCalled()
    expect(getUserModels).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Open Magpie' }))
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce())
    const url = new URL(vi.mocked(window.open).mock.calls[0][0] as string)
    expect(url.protocol).toBe('magpie:')
    expect(url.searchParams.get('responses')).toBe('https://gateway.example/v1')
    expect(url.searchParams.has('models')).toBe(false)
  })
})

describe('client import Chinese interface', () => {
  it.each(['cc-switch', 'magpie'] as const)(
    'renders the %s dialog entirely in Simplified Chinese',
    async (client) => {
      const translations = createInstance()
      await translations.init({
        lng: 'zhCN',
        resources: { zhCN },
        initAsync: false,
      })
      const label = client === 'cc-switch' ? 'CC Switch' : 'Magpie'
      render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={translations}>
            <ClientImportDialog
              open
              onOpenChange={vi.fn()}
              client={client}
              apiKey={fixtureKey}
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
      expect(
        screen.getByRole('dialog', { name: `导入到 ${label}` })
      ).toBeVisible()
      expect(
        screen.getByText('将当前 API 密钥和网关地址导入客户端。')
      ).toBeVisible()
      expect(screen.getByRole('button', { name: '复制导入链接' })).toBeEnabled()
      expect(
        screen.getByRole('button', { name: `打开 ${label}` })
      ).toBeEnabled()
      expect(screen.getByRole('button', { name: '取消' })).toBeVisible()
      expect(screen.getByRole('link', { name: `下载 ${label}` })).toBeVisible()
      expect(
        screen.getByText(new RegExp(`请先安装并打开 ${label}`))
      ).toBeVisible()
      if (client === 'magpie') {
        expect(
          screen.getByText('Magpie 会自动获取此密钥可用的模型。')
        ).toBeVisible()
      } else {
        expect(
          screen.getByText('可选。留空则使用客户端默认模型。')
        ).toBeVisible()
      }
      expect(fetchTokenKey).not.toHaveBeenCalled()
    }
  )
})
