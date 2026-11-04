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
import { useAuthStore } from '@/stores/auth-store'

import { Teams } from '../index'
import { TeamDetailView } from '../team-detail'
import { TeamEditor } from '../team-editor'
import { TeamInvitations } from '../team-invitations'
import { TeamMembers } from '../team-members'

afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.setUser(null)
})
function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

test('team administrator search resolves a user ID and submits the selected account', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        id: 27,
        username: 'alex',
        display_name: 'Alex Chen',
        email: 'alex@example.com',
        status: 1,
      },
    },
  })
  const save = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: {} } })
  render(
    <QueryClientProvider client={client()}>
      <TeamEditor open system onOpenChange={() => {}} />
    </QueryClientProvider>
  )
  await userEvent.type(screen.getByLabelText('Team name'), 'Research')
  const search = screen.getByRole('combobox', { name: 'Team administrator' })
  await userEvent.type(search, '27')
  await userEvent.click(
    await screen.findByRole('option', { name: /Alex Chen.*27/ })
  )
  expect(search).toHaveValue('Alex Chen (#27)')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      '/api/teams',
      expect.objectContaining({ admin_user_id: 27 })
    )
  )
})

test.each(['admin', 'member'] as const)(
  'a non-system %s opens their only team directly without an all-teams button',
  async (role) => {
    useAuthStore
      .getState()
      .auth.setUser({ id: 2, username: 'ordinary', role: 1 })
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      let data: unknown = []
      if (url === '/api/teams') data = [{ ...team, role }]
      else if (url === '/api/teams/7') data = { team, role, budget }
      else if (url.includes('/overview')) {
        data = {
          scope: role === 'admin' ? 'team' : 'mine',
          summary: {
            requests: 0,
            actual: 0,
            reserved: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            settled_requests: 0,
            reserved_requests: 0,
            refunded_requests: 0,
          },
          trend: [],
          models: [],
        }
      } else if (url.includes('/usage?')) data = { items: [], total: 0 }
      return { data: { success: true, data } }
    })
    render(
      <QueryClientProvider client={client()}>
        <Teams />
      </QueryClientProvider>
    )
    expect(
      await screen.findByRole('heading', { name: 'Research' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'All teams' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Research' })
    ).not.toBeInTheDocument()
  }
)
const team = {
  id: 7,
  name: 'Research',
  status: 1,
  balance: 500000,
  daily_limit: null,
  weekly_limit: 0,
}

test('a multi-team user switches teams and keeps each teams management permissions separate', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 2, username: 'multi-team', role: 1 })
  const rows = [
    { ...team, id: 7, name: 'Research', role: 'admin' },
    { ...team, id: 9, name: 'Testing', role: 'member' },
  ]
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data: unknown = []
    if (url === '/api/teams') data = rows
    else if (url === '/api/teams/7' || url === '/api/teams/9') {
      const selected = rows.find((row) => url.endsWith(`/${row.id}`))
      if (!selected) throw new Error('Unexpected fixture team')
      data = { team: selected, role: selected.role, budget }
    } else if (url.includes('/overview')) {
      data = {
        scope: url.includes('/7/') ? 'team' : 'mine',
        summary: {
          requests: 0,
          actual: 0,
          reserved: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          settled_requests: 0,
          reserved_requests: 0,
          refunded_requests: 0,
        },
        trend: [],
        models: [],
      }
    } else if (url.includes('/usage?')) data = { items: [], total: 0 }
    return { data: { success: true, data } }
  })
  render(
    <QueryClientProvider client={client()}>
      <Teams />
    </QueryClientProvider>
  )
  const selector = await screen.findByRole('combobox', { name: 'Current team' })
  expect(selector).toHaveValue('7')
  expect(await screen.findByRole('heading', { name: 'Research' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Team settings' })).toBeVisible()
  await userEvent.selectOptions(selector, '9')
  expect(await screen.findByRole('heading', { name: 'Testing' })).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Team settings' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'All teams' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText('Multiple team memberships found')
  ).not.toBeInTheDocument()
})
const budget = {
  daily_used: 0,
  daily_reserved: 0,
  weekly_used: 0,
  weekly_reserved: 0,
  day_start: 1793577600,
  week_start: 1793577600,
}

test('server member role hides manager actions and shared balance despite a stale system flag', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data: unknown = { items: [], total: 0 }
    if (url.endsWith('/7')) {
      data = {
        team: {
          id: 7,
          name: team.name,
          status: 1,
          daily_limit: 2500000,
          weekly_limit: 12500000,
        },
        role: 'member',
      }
    }
    if (url.includes('/overview')) {
      data = {
        scope: 'mine',
        summary: {
          requests: 0,
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
      }
    }
    if (
      url.endsWith('/members') ||
      url.endsWith('/invitations') ||
      url.endsWith('/quota')
    ) {
      data = []
    }
    return { data: { success: true, data } }
  })
  render(
    <QueryClientProvider client={client()}>
      <TeamDetailView teamId={7} system onBack={() => {}} />
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('heading', { name: 'Research' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.queryByText('Shared balance')).not.toBeInTheDocument()
  expect(screen.queryByText('Shared team budget')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('region', { name: 'Usage history' })
  ).not.toBeInTheDocument()
  expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/usage?'))
  expect(screen.getByText('$5')).toBeInTheDocument()
  expect(screen.getByText('$25')).toBeInTheDocument()
  expect(
    screen.queryByRole('region', { name: 'Members' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Team settings' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Adjust team balance' })
  ).not.toBeInTheDocument()
  expect(
    (await screen.findAllByText('No team usage yet')).length
  ).toBeGreaterThan(0)
})

test('team administrators manage members and invites without access to balance adjustment', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data: unknown = { items: [], total: 0 }
    if (url.endsWith('/7')) data = { team, role: 'admin', budget }
    if (url.includes('/overview')) {
      data = {
        scope: 'team',
        summary: {
          requests: 0,
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
      }
    }
    if (
      url.endsWith('/members') ||
      url.endsWith('/invitations') ||
      url.endsWith('/quota')
    ) {
      data = []
    }
    return { data: { success: true, data } }
  })
  render(
    <QueryClientProvider client={client()}>
      <TeamDetailView teamId={7} system={false} onBack={() => {}} />
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('button', { name: 'Team settings' })
  ).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Members' })).toBeInTheDocument()
  expect(
    screen.getByRole('region', { name: 'Invitations' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  const overview = screen.getByRole('region', { name: 'Overview' })
  const members = screen.getByRole('region', { name: 'Members' })
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  const limits = screen.getByRole('region', { name: 'Team spending limits' })
  const usage = await within(overview).findByRole('heading', {
    name: 'Team usage',
  })
  expect(
    limits.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(
    overview.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(screen.getByText('Shared balance')).toBeInTheDocument()
  expect(screen.getByText('Team spending today')).toBeInTheDocument()
  expect(screen.getByText('Team spending this week')).toBeInTheDocument()
  expect(
    screen.queryByText('Remaining member allowance')
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Adjust team balance' })
  ).not.toBeInTheDocument()
})

test('invitation generation uses seven days and keeps the returned secret out of query and mutation caches', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: [] } })
  const create = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: { token: 'one-time-test-secret' } },
  })
  const queryClient = client()
  render(
    <QueryClientProvider client={queryClient}>
      <TeamInvitations teamId={7} />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Generate invitation' })
  )
  expect(
    await screen.findByRole('button', { name: 'Copy invitation link' })
  ).toBeInTheDocument()
  expect(create).toHaveBeenCalledWith('/api/teams/7/invitations', {
    valid_days: 7,
  })
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    )
  ).not.toContain('one-time-test-secret')
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data)
    )
  ).not.toContain('one-time-test-secret')
  expect(screen.queryByText(/one-time-test-secret/)).not.toBeInTheDocument()
})

test('failed invitation generation does not show a success dialog', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: [] } })
  const create = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Team access denied' },
  })
  render(
    <QueryClientProvider client={client()}>
      <TeamInvitations teamId={7} />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Generate invitation' })
  )
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(
    screen.queryByRole('dialog', { name: 'Invitation created' })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Generate invitation' })
  ).toBeEnabled()
})

test('server member role directly opens the private team despite stale administrator authentication', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'stale-admin', role: 10 })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    const memberTeam = {
      id: 7,
      name: 'Research',
      role: 'member',
      status: 1,
      daily_limit: 2500000,
      weekly_limit: 12500000,
    }
    let data: unknown = []
    if (url === '/api/teams') data = [memberTeam]
    else if (url === '/api/teams/7') data = { team: memberTeam, role: 'member' }
    else if (url.includes('/overview')) {
      data = {
        scope: 'mine',
        summary: {
          requests: 0,
          actual: 0,
          reserved: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          settled_requests: 0,
          reserved_requests: 0,
          refunded_requests: 0,
        },
        trend: [],
        models: [],
      }
    } else if (url.includes('/usage?')) data = { items: [], total: 0 }
    return { data: { success: true, data } }
  })
  render(
    <QueryClientProvider client={client()}>
      <Teams />
    </QueryClientProvider>
  )
  expect(
    await screen.findByRole('heading', { name: 'Research' })
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('columnheader', { name: 'Shared balance' })
  ).not.toBeInTheDocument()
  expect(screen.getByText('$5')).toBeInTheDocument()
  expect(screen.getByText('$25')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Create team' })
  ).not.toBeInTheDocument()
})

test('changing a selected administrator search clears the old ID and requires a new selection', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data:
        url === '/api/user/27'
          ? { id: 27, username: 'alex', display_name: 'Alex Chen', status: 1 }
          : { items: [], total: 0 },
    },
  }))
  const save = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: {} } })
  render(
    <QueryClientProvider client={client()}>
      <TeamEditor open system onOpenChange={() => {}} />
    </QueryClientProvider>
  )
  await userEvent.type(screen.getByLabelText('Team name'), 'Research')
  const input = screen.getByRole('combobox', { name: 'Team administrator' })
  await userEvent.type(input, '27')
  await userEvent.click(
    await screen.findByRole('option', { name: /Alex Chen.*27/ })
  )
  await userEvent.clear(input)
  await userEvent.type(input, 'missing')
  await screen.findByText('No matching active users')
  await userEvent.keyboard('{Escape}')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Select a user from the search results'
  )
  expect(save).not.toHaveBeenCalled()
})

test('administrator search filters on the server and excludes inactive users before keyboard selection', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          {
            id: 41,
            username: 'alice',
            display_name: 'Alice',
            email: 'alice@example.com',
            status: 1,
          },
          {
            id: 42,
            username: 'inactive',
            display_name: 'Inactive account',
            status: 2,
          },
        ],
        total: 2,
      },
    },
  })
  render(
    <QueryClientProvider client={client()}>
      <TeamEditor open system onOpenChange={() => {}} />
    </QueryClientProvider>
  )
  const input = screen.getByRole('combobox', { name: 'Team administrator' })
  await userEvent.type(input, 'alice')
  await screen.findByRole('option', { name: /Alice.*41/ })
  expect(
    screen.queryByRole('option', { name: /Inactive account/ })
  ).not.toBeInTheDocument()
  expect(
    get.mock.calls.some(
      ([url]) => url.includes('keyword=alice') && url.includes('status=1')
    )
  ).toBe(true)
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(input).toHaveValue('Alice (#41)')
})

test('removing a member refreshes the list while a disabled member stays available to enable', async () => {
  let rows = [
    {
      id: 1,
      user_id: 20,
      username: 'remove-me',
      display_name: 'Remove Me',
      role: 'member',
      status: 1,
    },
    {
      id: 2,
      user_id: 21,
      username: 'disabled',
      display_name: 'Disabled Member',
      role: 'member',
      status: 2,
    },
  ]
  vi.spyOn(api, 'get').mockImplementation(async () => ({
    data: { success: true, data: rows },
  }))
  const remove = vi.spyOn(api, 'delete').mockImplementation(async () => {
    rows = rows.filter((row) => row.user_id !== 20)
    return { data: { success: true } }
  })
  render(
    <QueryClientProvider client={client()}>
      <TeamMembers teamId={7} system />
    </QueryClientProvider>
  )
  const row = await screen.findByRole('row', { name: /Remove Me/ })
  await userEvent.click(
    within(row).getByRole('button', { name: 'Remove member' })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() =>
    expect(screen.queryByText('Remove Me (#20)')).not.toBeInTheDocument()
  )
  expect(remove).toHaveBeenCalledWith('/api/teams/7/members/20', undefined)
  expect(
    within(screen.getByRole('row', { name: /Disabled Member/ })).getByRole(
      'button',
      { name: 'Enable' }
    )
  ).toBeVisible()
})

test('invitation list names the accepting user and acceptance time', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: [
        {
          id: 2,
          expired_at: 1999999999,
          revoked_at: 0,
          used_by: 4,
          used_at: 1793690000,
          accepted_username: 'lixiang',
          created_at: 1,
        },
      ],
    },
  })
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamInvitations teamId={1} />
    </QueryClientProvider>
  )
  expect(await screen.findByRole('cell', { name: 'lixiang' })).toBeVisible()
  expect(
    screen.getByRole('columnheader', { name: 'Accepted by' })
  ).toBeVisible()
  expect(
    screen.getByRole('columnheader', { name: 'Accepted at' })
  ).toBeVisible()
  expect(screen.getByRole('cell', { name: 'Accepted' })).toBeVisible()
})
