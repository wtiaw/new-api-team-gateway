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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCoreRowModel,
  useReactTable,
  type PaginationState,
} from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DataTablePagination } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { teamGet } from './api'
import { TeamQueryState } from './query-state'
import { TeamQuotaRecords } from './team-quota-records'
import { TeamUsageExport } from './team-usage-export'
import { TeamUsageTable } from './team-usage-table'
import type { TeamUsage } from './types'

export function TeamRecords(props: {
  teamId: number
  kind: 'usage' | 'quota'
}) {
  if (props.kind === 'quota') return <TeamQuotaRecords teamId={props.teamId} />
  return <TeamUsageHistory teamId={props.teamId} />
}
function TeamUsageHistory(props: { teamId: number }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const records = useQuery({
    queryKey: ['teams', props.teamId, 'usage', pagination, search],
    queryFn: () =>
      teamGet<{ items: TeamUsage[]; total: number }>(
        `/api/teams/${props.teamId}/usage?page=${
          pagination.pageIndex + 1
        }&page_size=${pagination.pageSize}&search=${encodeURIComponent(search)}`
      ),
  })
  const table = useReactTable({
    data: records.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: records.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  return (
    <div className='space-y-3 py-3'>
      <Label htmlFor='team-usage-search'>{t('Filter records')}</Label>
      <Input
        id='team-usage-search'
        maxLength={128}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
          setPagination((current) => ({ ...current, pageIndex: 0 }))
        }}
        placeholder={t('Search member, model, request or status')}
      />
      <p className='text-muted-foreground text-sm'>
        {t(
          'Team usage contains team-funded requests only. Members see only their own requests.'
        )}
      </p>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          disabled={records.isFetching || refreshing}
          aria-busy={refreshing}
          onClick={async () => {
            setRefreshing(true)
            await Promise.allSettled([
              records.refetch(),
              client.invalidateQueries({
                queryKey: ['teams', props.teamId],
              }),
            ])
            setRefreshing(false)
          }}
        >
          {t('Refresh')}
        </Button>
        <TeamUsageExport teamId={props.teamId} filter={search} />
      </div>
      <TeamQueryState query={records}>
        {(data) => <TeamUsageTable rows={data.items} />}
      </TeamQueryState>
      <DataTablePagination table={table} />
    </div>
  )
}
