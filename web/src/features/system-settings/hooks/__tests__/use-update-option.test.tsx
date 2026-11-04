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
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import * as settingsApi from '../../api'
import { useUpdateOption } from '../use-update-option'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each(['GroupRatio', 'group_ratio_setting.group_ratio', 'GroupGroupRatio'])(
  'refreshes channel, key and team group choices after saving %s',
  async (key) => {
    vi.spyOn(settingsApi, 'updateSystemOption').mockResolvedValue({
      success: true,
      message: '',
    })
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    const keys = ['groups', 'user-groups', 'team-group-options', 'pricing']
    for (const name of keys) client.setQueryData([name], { old: true })
    const { result } = renderHook(() => useUpdateOption(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    await act(() => result.current.mutateAsync({ key, value: '{"new":1.5}' }))
    for (const name of keys) {
      expect(client.getQueryState([name])?.isInvalidated).toBe(true)
    }
    client.clear()
  }
)
