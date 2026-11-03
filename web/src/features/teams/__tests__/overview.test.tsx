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
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { TeamBudget } from '../team-budget'
import { TeamDetailView } from '../team-detail'
import { TeamOverview } from '../team-overview'
import type { TeamOverviewData } from '../types'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 800, 256)
  )
})

const metrics = {
  requests: 612,
  settled_requests: 600,
  reserved_requests: 7,
  refunded_requests: 5,
  actual: 14,
  reserved: 8,
  prompt_tokens: 1200,
  completion_tokens: 600,
}
const overview: TeamOverviewData = {
  scope: 'mine',
  days: 7,
  start_time: 1793116800,
  end_time: 1793635200,
  summary: metrics,
  trend: [{ ...metrics, day_start: 1793577600 }],
  models: [{ ...metrics, model_name: 'gpt-test' }],
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <TeamOverview teamId={7} />
    </QueryClientProvider>
  )
  return client
}

test('member limit cards show own calendar day and week spending independently of the chart range', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        ...overview,
        period_usage: {
          daily_used: 14,
          weekly_used: 1000000,
          daily_reserved: 30,
          weekly_reserved: 40,
          day_start: 1793577600,
          week_start: 1793577600,
        },
      },
    },
  })
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamOverview
        teamId={7}
        detail={{
          role: 'member',
          team: {
            id: 7,
            name: 'Research',
            role: 'member',
            status: 1,
            daily_limit: 5000000,
            weekly_limit: 25000000,
          },
        }}
      />
    </QueryClientProvider>
  )
  const limits = screen.getByRole('region', { name: 'Team spending limits' })
  expect(
    await within(limits).findByText('My spending today')
  ).toBeInTheDocument()
  expect(await within(limits).findByText('$0.000028')).toBeInTheDocument()
  expect(within(limits).getByText('My spending this week')).toBeInTheDocument()
  expect(within(limits).getByText('$2')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
  expect(await within(limits).findByText('$2')).toBeInTheDocument()
  expect(within(limits).queryByText('Available')).not.toBeInTheDocument()
  expect(within(limits).queryByText('Reserved')).not.toBeInTheDocument()
  expect(within(limits).queryByText('Shared balance')).not.toBeInTheDocument()
})

test('overview uses server totals, shows member scope and preserves tiny settled costs', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: overview },
  })
  mount()
  expect(
    await screen.findByRole('heading', { name: 'My team usage' })
  ).toBeInTheDocument()
  expect(
    screen.getByText('Only your requests funded by this team are shown.')
  ).toBeInTheDocument()
  const models = screen.getByRole('table', { name: 'Usage by model' })
  expect(within(models).getByText('612')).toBeInTheDocument()
  expect(within(models).getByText('$0.000028')).toBeInTheDocument()
  expect(within(models).getByText('1,200')).toBeInTheDocument()
  const metric = screen.getByRole('button', { name: 'Actual cost' })
  await userEvent.click(metric)
  expect(metric).toHaveAttribute('aria-pressed', 'true')
  await userEvent.tab()
  await userEvent.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Tokens' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
})

test('choosing thirty days fetches that range and displays the manager scope and empty state', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.includes('days=30')
        ? {
            ...overview,
            scope: 'team',
            summary: { ...metrics, requests: 0 },
            trend: [],
            models: [],
          }
        : overview,
    },
  }))
  mount()
  await screen.findByRole('heading', { name: 'My team usage' })
  const range = screen.getByRole('button', { name: 'Last 30 days' })
  await userEvent.click(range)
  expect(await screen.findByText('No team usage yet')).toBeInTheDocument()
  expect(range).toHaveAttribute('aria-pressed', 'true')
  expect(
    screen.getByRole('heading', { name: 'Team usage' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

test('failed overview offers retry which recovers to the selected usage data', async () => {
  vi.spyOn(api, 'get')
    .mockRejectedValueOnce(new Error('Overview unavailable'))
    .mockResolvedValue({ data: { success: true, data: overview } })
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByRole('table', { name: 'Usage by model' })
  ).toBeInTheDocument()
})

test('either refresh action updates both overview and the shared balance', async () => {
  let balance = 500000
  let requests = 612
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (
      url.endsWith('/members') ||
      url.endsWith('/invitations') ||
      url.endsWith('/quota')
    ) {
      return { data: { success: true, data: [] } }
    }
    if (url.includes('/usage?')) {
      return { data: { success: true, data: { items: [], total: 0 } } }
    }
    return {
      data: {
        success: true,
        data: url.includes('/overview')
          ? { ...overview, scope: 'team', summary: { ...metrics, requests } }
          : {
              role: 'admin',
              team: {
                id: 7,
                name: 'Research',
                balance,
                daily_limit: null,
                weekly_limit: null,
              },
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <TeamDetailView teamId={7} system={false} onBack={() => {}} />
    </QueryClientProvider>
  )
  await screen.findByRole('heading', { name: 'Team usage' })
  balance = 1000000
  requests = 888
  await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  await waitFor(() => expect(screen.getByText('888')).toBeInTheDocument())
  expect(screen.getAllByText('$2').length).toBeGreaterThan(0)
  balance = 1500000
  requests = 999
  await userEvent.click(screen.getByRole('button', { name: 'Refresh balance' }))
  await waitFor(() => expect(screen.getByText('999')).toBeInTheDocument())
  expect(screen.getAllByText('$3').length).toBeGreaterThan(0)
})

test('pending overview shows loading and disables refresh until the response arrives', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(api, 'get').mockImplementation(async () => {
    await pending
    return { data: { success: true, data: overview } }
  })
  mount()
  expect(screen.getByText('Loading...')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeDisabled()
  release()
  expect(
    await screen.findByRole('heading', { name: 'My team usage' })
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeEnabled()
})

test('overview hides reservation amounts and lets admins filter trends and model totals by member', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: {
        ...overview,
        scope: url.includes('user_id=3') ? 'member' : 'team',
        member_id: url.includes('user_id=3') ? 3 : 0,
        members: [
          { user_id: 3, username: 'wtiaw2' },
          { user_id: 4, username: 'lixiang' },
        ],
        summary: { ...metrics, requests: url.includes('user_id=3') ? 9 : 612 },
      },
    },
  }))
  mount()
  const selector = await screen.findByRole('combobox', { name: 'Member' })
  expect(
    screen.getByRole('option', { name: 'All members' })
  ).toBeInTheDocument()
  expect(screen.queryByText('Reserved')).not.toBeInTheDocument()
  expect(screen.queryByText('reserved')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('columnheader', { name: 'Reserved' })
  ).not.toBeInTheDocument()
  await userEvent.selectOptions(selector, '3')
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=7&user_id=3')
  )
  expect(
    await screen.findByRole('heading', { name: 'Team usage · wtiaw2' })
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=30&user_id=3')
  )
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Member' }),
    '0'
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=30')
  )
})

test('ordinary members never receive a member selector even when own totals are empty', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: overview },
  })
  mount()
  await screen.findByRole('heading', { name: 'My team usage' })
  expect(
    screen.queryByRole('combobox', { name: 'Member' })
  ).not.toBeInTheDocument()
})

test('a failed member selection can return to all members without reloading', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.includes('user_id=3')) throw new Error('Member unavailable')
    return {
      data: {
        success: true,
        data: {
          ...overview,
          scope: 'team',
          members: [{ user_id: 3, username: 'wtiaw2' }],
        },
      },
    }
  })
  mount()
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: 'Member' }),
    '3'
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'All members' })
  )
  expect(
    await screen.findByRole('heading', { name: 'Team usage' })
  ).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Member' })).toHaveValue('0')
})

test('trend comparison loads multiple independent members and keeps them across date and metric changes', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: {
        ...overview,
        days: url.includes('days=30') ? 30 : 7,
        scope: url.includes('user_id=') ? 'member' : 'team',
        member_id: url.includes('user_id=3') ? 3 : 4,
        members: [
          { user_id: 3, username: 'wtiaw2' },
          { user_id: 4, username: 'lixiang' },
        ],
      },
    },
  }))
  mount()
  const input = await screen.findByRole('combobox', { name: 'Compare members' })
  await userEvent.click(input)
  await userEvent.click(
    within(await screen.findByRole('listbox')).getByRole('option', {
      name: 'wtiaw2',
    })
  )
  await userEvent.keyboard('{Escape}')
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Compare members' })
  )
  await userEvent.click(
    within(await screen.findByRole('listbox')).getByRole('option', {
      name: 'lixiang',
    })
  )
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=7&user_id=3')
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=7&user_id=4')
  )
  await userEvent.click(screen.getByRole('button', { name: 'Actual cost' }))
  await userEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=30&user_id=3')
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/teams/7/overview?days=30&user_id=4')
  )
  expect(
    await screen.findByRole('button', { name: 'Actual cost' })
  ).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(
    screen.getByRole('button', { name: 'Reset comparison' })
  )
  expect(
    screen.getByRole('button', { name: 'Reset comparison' })
  ).toBeDisabled()
})

test('selected member allowance uses their own spending while shared totals stay separate', () => {
  render(
    <TeamBudget
      selectedMember
      detail={{
        role: 'admin',
        team: {
          id: 1,
          name: 'Team',
          role: 'admin',
          status: 1,
          balance: 50000000,
          daily_limit: 2500000,
          weekly_limit: 12500000,
        },
        budget: {
          daily_used: 500000,
          weekly_used: 1000000,
          daily_reserved: 0,
          weekly_reserved: 0,
          day_start: 1,
          week_start: 1,
        },
      }}
      memberUsage={{
        daily_used: 14,
        weekly_used: 28,
        daily_reserved: 0,
        weekly_reserved: 0,
        day_start: 1,
        week_start: 1,
      }}
    />
  )
  expect(screen.getByText('Daily team allowance per member')).toBeVisible()
  expect(screen.getByText('Weekly team allowance per member')).toBeVisible()
  expect(screen.getByText('$4.999972')).toBeVisible()
  expect(screen.getByText('$24.999944')).toBeVisible()
  expect(screen.getByText('Team spending today')).toBeVisible()
  expect(screen.getByText('$1')).toBeVisible()
})
