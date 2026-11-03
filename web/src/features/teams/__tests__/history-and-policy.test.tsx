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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { FundingPolicyDialog } from '../funding-policy-dialog'
import { TeamInvitationPage } from '../invitation-page'
import { TeamDetailView } from '../team-detail'
import { TeamEditor } from '../team-editor'
import { TeamRecords } from '../team-records'
import { TeamUsageTable } from '../team-usage-table'

afterEach(() => vi.restoreAllMocks())
const row = {
  request_id: 'first-request',
  user_id: 7,
  token_id: 8,
  source: 'team',
  model_name: 'test-model',
  actual: 500,
  reserved: 500,
  state: 'settled',
  created_at: 1,
  prompt_tokens: 1,
  completion_tokens: 1,
  fallback_reason: '',
}
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

test('small team charges preserve six decimal places and the reported input and output tokens', () => {
  render(
    <TeamUsageTable
      rows={[
        {
          ...row,
          actual: 14,
          reserved: 14,
          prompt_tokens: 12,
          completion_tokens: 8,
        },
      ]}
    />
  )
  expect(screen.getByText('$0.000028')).toBeVisible()
  expect(
    screen.queryByRole('columnheader', { name: 'Reserved' })
  ).not.toBeInTheDocument()
  const tokens = within(
    screen.getByRole('group', { name: 'Input / output tokens' })
  )
  expect(tokens.getByRole('img', { name: 'Input tokens' })).toBeVisible()
  expect(tokens.getByRole('img', { name: 'Output tokens' })).toBeVisible()
  expect(tokens.getByText('12')).toBeVisible()
  expect(tokens.getByText('8')).toBeVisible()
})

test('history refresh updates records, shared balance and overview without reloading the page', async () => {
  let latest = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (
      url.endsWith('/members') ||
      url.endsWith('/invitations') ||
      url.endsWith('/quota')
    ) {
      return { data: { success: true, data: [] } }
    }
    if (url.includes('/overview?')) {
      return {
        data: {
          success: true,
          data: {
            scope: 'team',
            summary: {
              requests: latest ? 808 : 0,
              settled_requests: 0,
              reserved_requests: 0,
              refunded_requests: 0,
              actual: 0,
              reserved: 0,
              prompt_tokens: 0,
              completion_tokens: 0,
            },
            trend: [],
            models: [],
          },
        },
      }
    }
    if (url.includes('/usage?')) {
      return {
        data: {
          success: true,
          data: { items: latest ? [row] : [], total: latest ? 1 : 0 },
        },
      }
    }
    return {
      data: {
        success: true,
        data: {
          team: {
            id: 7,
            name: 'Research',
            status: 1,
            balance: latest ? 1000000 : 500000,
            daily_limit: null,
            weekly_limit: null,
          },
          role: 'admin',
          budget: {
            daily_used: 0,
            daily_reserved: 0,
            weekly_used: 0,
            weekly_reserved: 0,
            day_start: 1793577600,
            week_start: 1793577600,
          },
        },
      },
    }
  })
  const cachedClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  })
  render(
    <QueryClientProvider client={cachedClient}>
      <TeamDetailView teamId={7} system={false} onBack={() => {}} />
    </QueryClientProvider>
  )
  expect(
    (await screen.findAllByText('No team usage yet')).length
  ).toBeGreaterThan(0)
  await within(screen.getByRole('region', { name: 'Overview' })).findByRole(
    'heading',
    { name: 'Team usage' }
  )
  latest = true
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText('first-request')).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getAllByText('$2').length).toBeGreaterThan(0)
  )
  expect(
    await within(screen.getByRole('region', { name: 'Overview' })).findByText(
      '808'
    )
  ).toBeInTheDocument()
})

test('usage history requests the next server page and resets to the first page when searching', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: {
        items: [
          {
            ...row,
            request_id: url.includes('page=2')
              ? 'second-page-request'
              : 'first-request',
          },
        ],
        total: 201,
      },
    },
  }))
  render(
    <QueryClientProvider client={client()}>
      <TeamRecords teamId={7} kind='usage' />
    </QueryClientProvider>
  )
  expect(await screen.findByText('first-request')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  expect(await screen.findByTitle('second-page-request')).toBeInTheDocument()
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Filter records' }),
    'settled'
  )
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      '/api/teams/7/usage?page=1&page_size=20&search=settled'
    )
  )
})

test('full usage export requests the authenticated server CSV endpoint for the current filter', async () => {
  const csv = new Blob(['request_id\r\nold-request\r\n'], { type: 'text/csv' })
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async (url) =>
      url.includes('/export?')
        ? { data: csv, headers: { 'content-type': 'text/csv' } }
        : { data: { success: true, data: { items: [row], total: 1000 } } }
    )
  const objectURL = vi.fn(() => 'blob:test')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: objectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(
    <QueryClientProvider client={client()}>
      <TeamRecords teamId={7} kind='usage' />
    </QueryClientProvider>
  )
  await screen.findByText('first-request')
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Filter records' }),
    'test model'
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Export all matching records' })
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/teams/7/usage/export?search=test%20model',
      { responseType: 'blob' }
    )
  )
  expect(objectURL).toHaveBeenCalledWith(csv)
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

test('a team that forbids personal backup disables automatic policies but keeps personal only available', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.includes('team-key-policies')
        ? { mode: 'team_only', team_id: 7 }
        : [
            {
              id: 7,
              name: 'Restricted',
              status: 1,
              allow_personal_backup: false,
            },
          ],
    },
  }))
  render(
    <QueryClientProvider client={client()}>
      <FundingPolicyDialog tokenId={3} open onOpenChange={() => {}} />
    </QueryClientProvider>
  )
  await screen.findByRole('option', { name: 'Restricted' })
  expect(
    screen.getByRole('option', { name: 'Team first, personal backup' })
  ).toBeDisabled()
  expect(
    screen.getByRole('option', { name: 'Personal first, team backup' })
  ).toBeDisabled()
  expect(screen.getByRole('option', { name: 'Personal only' })).toBeEnabled()
})

test('an invitation used by another user shows its expiry and does not claim the current user joined', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        team: { name: 'Research' },
        state: 'accepted',
        expired_at: 1793577600,
        accepted_by_current_user: false,
      },
    },
  })
  const root = createRootRoute({
    component: () => <TeamInvitationPage token='test-invitation' />,
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Invitation already used')).toBeInTheDocument()
  expect(screen.queryByText('Team invitation accepted')).not.toBeInTheDocument()
  expect(screen.getByText(/2026-11-02 08:00:00/)).toBeInTheDocument()
  expect(screen.getByText(/Asia\/Shanghai/)).toBeInTheDocument()
})

test('team administrators can read the backup restriction but cannot include it in team updates', async () => {
  const save = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  render(
    <QueryClientProvider client={client()}>
      <TeamEditor
        team={{
          id: 7,
          name: 'Restricted',
          role: 'admin',
          status: 1,
          balance: 0,
          daily_limit: null,
          weekly_limit: null,
          allow_personal_backup: false,
        }}
        system={false}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
  expect(
    screen.getByRole('switch', { name: 'Allow personal backup' })
  ).toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.getByRole('switch', { name: 'Allow personal backup' })
  ).not.toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith('/api/teams/7', {
      name: 'Restricted',
      daily_limit: null,
      weekly_limit: null,
    })
  )
})

test('usage displays usernames and key names with safe fallbacks', () => {
  render(
    <TeamUsageTable
      rows={[
        {
          ...row,
          request_id: 'named',
          username: 'wtiaw2',
          token_name: 'Codex laptop',
        },
        { ...row, request_id: 'playground', token_id: 0 },
        { ...row, request_id: 'missing-key' },
      ]}
    />
  )
  expect(
    screen.getByRole('columnheader', { name: 'Member / API Key' })
  ).toBeInTheDocument()
  expect(screen.getByText('wtiaw2')).toBeInTheDocument()
  expect(screen.getByText('Codex laptop')).toBeInTheDocument()
  expect(screen.getByText('Playground')).toBeInTheDocument()
  expect(screen.getByText('API Key #8')).toBeInTheDocument()
})

test('in-flight postpaid requests use progress status without reservation amounts', () => {
  render(<TeamUsageTable rows={[{ ...row, state: 'reserved' }]} />)
  expect(screen.getByRole('cell', { name: 'In Progress' })).toBeVisible()
  expect(
    screen.queryByRole('columnheader', { name: 'Reserved' })
  ).not.toBeInTheDocument()
})

test('grouped usage rows keep trace details behind an explicit detail action', async () => {
  const user = userEvent.setup()
  const request = '202611031720001234567890long-request-id'
  render(
    <TeamUsageTable
      rows={[
        {
          ...row,
          request_id: request,
          username: 'lixiang',
          token_name: 'Codex laptop',
          actual: 14,
          prompt_tokens: 12,
          completion_tokens: 8,
          fallback_reason: 'Personal balance is insufficient',
        },
      ]}
    />
  )
  expect(
    screen.getByRole('columnheader', { name: 'Member / API Key' })
  ).toBeVisible()
  expect(
    screen.queryByRole('columnheader', { name: 'Request ID' })
  ).not.toBeInTheDocument()
  expect(screen.queryByText(request)).not.toBeInTheDocument()
  expect(screen.getByText('$0.000028')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /Details/ }))
  const dialog = within(
    await screen.findByRole('dialog', { name: 'Usage record details' })
  )
  expect(dialog.getByText(request)).toBeVisible()
  expect(dialog.getByText('Codex laptop (#8)')).toBeVisible()
  expect(dialog.getByText('Personal balance is insufficient')).toBeVisible()
  await user.click(dialog.getByRole('button', { name: 'Copy request ID' }))
  expect(await navigator.clipboard.readText()).toBe(request)
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

test('historical funding sources are explicit and unknown sources are not labeled personal', () => {
  render(
    <TeamUsageTable
      rows={[
        { ...row, request_id: 'wallet', source: 'wallet' },
        { ...row, request_id: 'subscription', source: 'subscription' },
        { ...row, request_id: 'unknown', source: 'future-source' },
      ]}
    />
  )
  expect(screen.getByText('Personal balance')).toBeVisible()
  expect(screen.getByText('Subscription')).toBeVisible()
  expect(screen.getByText('Unknown')).toBeVisible()
})
