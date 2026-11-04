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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { TeamEditor } from '../team-editor'
import { TeamUsageTable } from '../team-usage-table'

const team = {
  id: 7,
  name: 'Research',
  role: 'system' as const,
  status: 1,
  daily_limit: null,
  weekly_limit: null,
}
function editor(system = true, settings = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <TeamEditor
        team={{ ...team, ...settings }}
        system={system}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}
afterEach(() => vi.restoreAllMocks())
test('system administrator selects the member groups shared by personal and team payments', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: ['default', 'team-codex', 'auto'] },
  })
  const save = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  editor()
  const groups = await screen.findByRole('combobox', {
    name: 'Team allowed groups',
  })
  await waitFor(() => expect(groups).toBeEnabled())
  await userEvent.click(groups)
  await userEvent.click(
    await screen.findByRole('option', { name: 'team-codex' })
  )
  await userEvent.keyboard('{Escape}')
  await userEvent.selectOptions(
    screen.getByLabelText('Default team group'),
    'team-codex'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      '/api/teams/7',
      expect.objectContaining({
        allowed_groups: ['team-codex'],
        default_group: 'team-codex',
      })
    )
  )
})
test('team grants without a default selection cannot be saved', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: ['default'] },
  })
  const save = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  editor(true, { allowed_groups: ['default'] })
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Select a default from the allowed team groups'
  )
  expect(save).not.toHaveBeenCalled()
})
test('team administrator can read grants but cannot submit routing settings', async () => {
  const save = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const get = vi.spyOn(api, 'get')
  editor(false, { allowed_groups: ['team-codex'], default_group: 'team-codex' })
  const region = within(
    screen.getByRole('region', { name: 'Team routing groups' })
  )
  expect(region.getByText('team-codex', { exact: true })).toBeVisible()
  expect(region.queryByRole('combobox')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(save).toHaveBeenCalled())
  const body = save.mock.calls[0][1] as Record<string, unknown>
  expect(body).not.toHaveProperty('allowed_groups')
  expect(body).not.toHaveProperty('default_group')
  expect(get).not.toHaveBeenCalledWith('/api/group/')
})

test('retrying failed group loading does not submit the team form', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ data: { success: true, data: ['development'] } })
  const save = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  editor()
  await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Team allowed groups' })
    ).toBeEnabled()
  )
  expect(get).toHaveBeenCalledTimes(2)
  expect(save).not.toHaveBeenCalled()
})

test('team usage details show the actual resource group and channel snapshot', async () => {
  render(
    <TeamUsageTable
      rows={[
        {
          request_id: 'request-resource-snapshot',
          user_id: 7,
          token_id: 8,
          source: 'team',
          model_name: 'gpt-test',
          reserved: 0,
          actual: 14,
          state: 'settled',
          created_at: 1,
          prompt_tokens: 12,
          completion_tokens: 8,
          fallback_reason: '',
          using_group: 'development',
          channel_id: 9,
          channel_name: 'CPA shared',
        },
      ]}
    />
  )
  expect(screen.getByText('development')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Details' }))
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Usage record details' })
  )
  expect(dialog.getByText('development')).toBeVisible()
  expect(dialog.getByText('CPA shared')).toBeVisible()
})
