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
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatQuotaWithCurrency } from '@/lib/currency'

import { teamGet } from './api'
import { TeamQueryState } from './query-state'
import type { QuotaOperation } from './types'

export function TeamQuotaRecords(props: { teamId: number }) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const records = useQuery({
    queryKey: ['teams', props.teamId, 'quota'],
    queryFn: () =>
      teamGet<QuotaOperation[]>(`/api/teams/${props.teamId}/quota`),
  })
  return (
    <div className='space-y-3 py-3'>
      <Label htmlFor='quota-filter'>{t('Filter records')}</Label>
      <Input
        id='quota-filter'
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <TeamQueryState query={records}>
        {(rows) => (
          <StaticDataTable
            data={rows.filter((row) =>
              `${row.actor_id} ${row.reason}`
                .toLowerCase()
                .includes(filter.toLowerCase())
            )}
            getRowKey={(row) => row.id}
            emptyContent={t('No balance adjustments')}
            columns={[
              {
                id: 'time',
                header: t('Time'),
                cell: (row) =>
                  dayjs.unix(row.created_at).format('YYYY-MM-DD HH:mm:ss'),
              },
              {
                id: 'actor',
                header: t('User ID'),
                cell: (row) => row.actor_id,
              },
              {
                id: 'mode',
                header: t('Adjustment'),
                cell: (row) => {
                  if (row.mode === 'add') return t('Add')
                  if (row.mode === 'subtract') return t('Subtract')
                  return t('Set balance')
                },
              },
              {
                id: 'value',
                header: t('Amount'),
                cell: (row) => formatQuotaWithCurrency(row.value),
              },
              {
                id: 'before',
                header: t('Balance before'),
                cell: (row) => formatQuotaWithCurrency(row.balance_before),
              },
              {
                id: 'after',
                header: t('Balance after'),
                cell: (row) => formatQuotaWithCurrency(row.balance_after),
              },
              {
                id: 'reason',
                header: t('Reason'),
                cell: (row) => row.reason,
              },
            ]}
          />
        )}
      </TeamQueryState>
    </div>
  )
}
