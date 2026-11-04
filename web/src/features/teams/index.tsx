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

import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { useAuthStore } from '@/stores/auth-store'

import { teamGet } from './api'
import { TeamQueryState } from './query-state'
import { TeamDetailView } from './team-detail'
import { TeamEditor } from './team-editor'
import type { Team } from './types'

export function Teams() {
  const { t } = useTranslation()
  const system = useAuthStore((state) => (state.auth.user?.role ?? 0) >= 10)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [create, setCreate] = useState(false)
  const teams = useQuery({
    queryKey: ['teams', 'list'],
    queryFn: () => teamGet<Team[]>('/api/teams'),
  })
  const canCreate =
    system && (!teams.data || teams.data.every((row) => row.role === 'system'))
  return (
    <Main className='overflow-y-auto p-4 sm:p-6'>
      <div className='mb-6 flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-semibold'>{t('Teams')}</h1>
          <p className='text-muted-foreground text-sm'>
            {t('Shared funding, members and team spending limits')}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreate(true)}>{t('Create team')}</Button>
        )}
      </div>
      <TeamQueryState query={teams}>
        {(rows) => {
          const systemView =
            rows.some((row) => row.role === 'system') ||
            (system && rows.length === 0)
          const memberSelection = rows.some((row) => row.id === selectedId)
            ? selectedId
            : (rows.find((row) => row.status === 1)?.id ?? rows[0]?.id)
          const detailId = systemView ? selectedId : memberSelection
          if (!systemView && rows.length === 0) {
            return (
              <EmptyState
                bordered
                title={t('No teams yet')}
                description={t(
                  'Ask a team administrator for an invitation link.'
                )}
              />
            )
          }
          return detailId && rows.some((row) => row.id === detailId) ? (
            <div className='space-y-4'>
              {!systemView && rows.length > 1 && (
                <div className='max-w-sm space-y-2'>
                  <Label htmlFor='current-team'>{t('Current team')}</Label>
                  <NativeSelect
                    id='current-team'
                    value={detailId}
                    onChange={(event) =>
                      setSelectedId(Number(event.target.value))
                    }
                  >
                    {rows.map((row) => (
                      <NativeSelectOption key={row.id} value={row.id}>
                        {row.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              )}
              <TeamDetailView
                key={detailId}
                teamId={detailId}
                system={systemView}
                onBack={systemView ? () => setSelectedId(null) : undefined}
              />
            </div>
          ) : (
            <StaticDataTable
              data={rows}
              getRowKey={(row) => row.id}
              emptyContent={
                <EmptyState
                  title={t('No teams yet')}
                  description={t(
                    'Ask a team administrator for an invitation link.'
                  )}
                />
              }
              columns={[
                {
                  id: 'name',
                  header: t('Team'),
                  cell: (row) => (
                    <Button
                      variant='link'
                      className='max-w-72 truncate'
                      onClick={() => setSelectedId(row.id)}
                    >
                      {row.name}
                    </Button>
                  ),
                },
                {
                  id: 'role',
                  header: t('Role'),
                  cell: (row) =>
                    row.role === 'member' ? t('Member') : t('Administrator'),
                },
                {
                  id: 'status',
                  header: t('Status'),
                  cell: (row) =>
                    row.status === 1 ? t('Enabled') : t('Disabled'),
                },
                ...(rows.some(
                  (row) =>
                    (row.role === 'admin' || row.role === 'system') &&
                    row.balance != null
                )
                  ? [
                      {
                        id: 'balance',
                        header: t('Shared balance'),
                        cell: (row: Team) =>
                          (row.role === 'admin' || row.role === 'system') &&
                          row.balance != null
                            ? formatQuotaWithCurrency(row.balance)
                            : '-',
                      },
                    ]
                  : []),
                {
                  id: 'daily',
                  header: t('Daily team allowance per member'),
                  cell: (row) =>
                    row.daily_limit == null
                      ? t('Unlimited')
                      : formatQuotaWithCurrency(row.daily_limit),
                },
                {
                  id: 'weekly',
                  header: t('Weekly team allowance per member'),
                  cell: (row) =>
                    row.weekly_limit == null
                      ? t('Unlimited')
                      : formatQuotaWithCurrency(row.weekly_limit),
                },
              ]}
            />
          )
        }}
      </TeamQueryState>
      {create && canCreate && (
        <TeamEditor open system onOpenChange={setCreate} />
      )}
    </Main>
  )
}
