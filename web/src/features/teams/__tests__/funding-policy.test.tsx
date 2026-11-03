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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { FundingPolicyDialog } from '../funding-policy-dialog'
import { usdToQuota } from '../quota'

afterEach(() => vi.restoreAllMocks())

describe('Team funding selection', () => {
  test('blank limits remain unlimited and zero remains blocked', () => {
    expect(usdToQuota('')).toBeNull()
    expect(usdToQuota('0')).toBe(0)
    expect(usdToQuota('1.25')).toBe(625000)
    expect(() => usdToQuota('-1')).toThrow()
    expect(() => usdToQuota('-0.0000001')).toThrow()
    expect(() => usdToQuota('0x10')).toThrow()
    expect(() => usdToQuota('Infinity')).toThrow()
  })

  test('existing keys stay legacy until the owner explicitly saves a selected policy', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => ({
      data: {
        success: true,
        data: url.includes('team-key-policies')
          ? { mode: 'legacy', team_id: 0 }
          : [{ id: 7, name: 'Research', status: 1 }],
      },
    }))
    const save = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <FundingPolicyDialog tokenId={3} open onOpenChange={() => {}} />
      </QueryClientProvider>
    )
    const mode = await screen.findByRole('combobox', { name: 'Funding source' })
    expect(mode).toHaveValue('legacy')
    expect(save).not.toHaveBeenCalled()
    await userEvent.selectOptions(mode, 'team_first')
    expect(
      screen.getByText(
        'Personal backup can spend your personal balance. Personal spending has no daily or weekly limit.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Team' }),
      '7'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('/api/team-key-policies/3', {
        mode: 'team_first',
        team_id: 7,
      })
    )
  })
})
