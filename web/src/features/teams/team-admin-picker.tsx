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
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from '@/components/ui/combobox'
import { getUser, searchUsers } from '@/features/users/api'
import type { User } from '@/features/users/types'
import { useDebounce } from '@/hooks/use-debounce'
import {
  createServerError,
  getServerErrorMessage,
} from '@/lib/server-error-message'

export function TeamAdminPicker(props: {
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  invalid: boolean
}) {
  const { t } = useTranslation()
  const anchor = useComboboxAnchor()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<User | null>(null)
  const keyword = useDebounce(search.trim(), 250)
  const users = useQuery({
    queryKey: ['team-admin-candidates', keyword],
    enabled: open,
    queryFn: async () => {
      if (/^[1-9]\d*$/.test(keyword) && Number.isSafeInteger(Number(keyword))) {
        const result = await getUser(Number(keyword))
        if (!result.success || !result.data) {
          throw createServerError(result, 'Failed to load users')
        }
        return { items: [result.data], total: 1 }
      }
      const result = await searchUsers({
        keyword,
        status: '1',
        p: 1,
        page_size: 20,
      })
      if (!result.success || !result.data) {
        throw createServerError(result, 'Failed to load users')
      }
      return result.data
    },
  })
  const searching =
    search.trim() !== keyword || users.isPending || users.isFetching
  const options = searching
    ? []
    : (users.data?.items ?? []).filter(
        (user) => user.status === 1 && !user.DeletedAt
      )
  const current =
    selected && String(selected.id) === props.value ? selected : null
  const label = current
    ? `${current.display_name || current.username} (#${current.id})`
    : ''
  return (
    <Combobox<User>
      items={options}
      value={current}
      inputValue={open ? search : label}
      open={open}
      filter={null}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onOpenChange={(value, details) => {
        setOpen(value)
        if (value && details.reason !== 'input-change') setSearch('')
      }}
      onInputValueChange={(value, details) => {
        if (details.reason !== 'input-change') return
        setSearch(value)
        props.onChange('')
      }}
      onValueChange={(user) => {
        setSelected(user)
        props.onChange(user ? String(user.id) : '')
      }}
    >
      <div ref={anchor}>
        <ComboboxInput
          id='team-admin'
          maxLength={128}
          className='w-full'
          aria-invalid={props.invalid}
          onBlur={props.onBlur}
          showClear={!!current}
          placeholder={t('Search name, username, email or ID')}
          triggerAriaLabel={t('Search users')}
        />
      </div>
      <ComboboxContent anchor={anchor}>
        {searching && (
          <div role='status' className='p-3'>
            <LoadingState inline size='sm' message={t('Searching users...')} />
          </div>
        )}
        {!searching && users.isError && (
          <ErrorState
            className='min-h-0 p-3'
            description={getServerErrorMessage(users.error)}
            onRetry={() => void users.refetch()}
          />
        )}
        {!searching && !users.isError && (
          <>
            <ComboboxEmpty>{t('No matching active users')}</ComboboxEmpty>
            <ComboboxList>
              {(user: User) => (
                <ComboboxItem key={user.id} value={user}>
                  <div className='min-w-0'>
                    <span className='block break-words'>
                      {user.display_name || user.username} (#{user.id})
                    </span>
                    <span className='text-muted-foreground block text-xs break-all'>
                      @{user.username}
                      {user.email ? ` · ${user.email}` : ''}
                    </span>
                  </div>
                </ComboboxItem>
              )}
            </ComboboxList>
            {users.data && users.data.total > options.length && (
              <p className='text-muted-foreground px-3 py-2 text-xs'>
                {t('Type more to narrow the user search.')}
              </p>
            )}
          </>
        )}
      </ComboboxContent>
    </Combobox>
  )
}
