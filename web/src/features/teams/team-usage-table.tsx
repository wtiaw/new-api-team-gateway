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
import dayjs from 'dayjs'
import { ArrowDown, ArrowUp, ChevronRight, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getFundingSourceLabel } from '@/features/usage-logs/lib/billing-source'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import type { TeamUsage } from './types'

function actualCost(row: TeamUsage) {
  return formatQuotaWithCurrency(row.actual, {
    digitsLarge: 6,
    digitsSmall: 6,
    abbreviate: false,
  })
}

function useUsageLabels() {
  const { t } = useTranslation()
  return {
    username: (row: TeamUsage) =>
      row.username || `${t('User ID')} #${row.user_id}`,
    keyName: (row: TeamUsage) =>
      row.token_name ||
      (row.token_id === 0
        ? t('Playground')
        : `${t('API Key')} #${row.token_id}`),
    source: (row: TeamUsage) =>
      t(getFundingSourceLabel(row.source) || 'Unknown'),
    state: (row: TeamUsage) =>
      t(row.state === 'reserved' ? 'In Progress' : row.state),
  }
}

const stateStyles: Record<string, string> = {
  settled:
    'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  refunded: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  reserved:
    'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400',
}

function UsageDetails({
  row,
  onClose,
}: {
  row: TeamUsage | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const label = useUsageLabels()
  if (!row) return null
  const fields = [
    [
      t('Username'),
      row.username ? `${row.username} (#${row.user_id})` : label.username(row),
    ],
    [
      t('API Key'),
      row.token_name
        ? `${row.token_name} (#${row.token_id})`
        : label.keyName(row),
    ],
    [t('Model'), row.model_name || '-'],
    ...(row.using_group ? [[t('Group'), row.using_group]] : []),
    ...(row.channel_name ? [[t('Channel'), row.channel_name]] : []),
    [t('Time'), dayjs.unix(row.created_at).format('YYYY-MM-DD HH:mm:ss')],
    [t('Actual cost'), actualCost(row)],
    [t('Actual funding source'), label.source(row)],
    [t('Input tokens'), formatNumber(row.prompt_tokens)],
    [t('Output tokens'), formatNumber(row.completion_tokens)],
    [t('Status'), label.state(row)],
  ]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t('Usage record details')}
    >
      <div className='bg-muted/30 mb-5 rounded-lg border p-3'>
        <div className='mb-1 flex items-center justify-between gap-2'>
          <span className='text-muted-foreground text-xs'>
            {t('Request ID')}
          </span>
          <CopyButton
            value={row.request_id}
            size='sm'
            aria-label={t('Copy request ID')}
          />
        </div>
        <p className='font-mono text-xs leading-relaxed break-all'>
          {row.request_id}
        </p>
      </div>
      <dl className='grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2'>
        {fields.map(([name, value]) => (
          <div key={name} className='min-w-0'>
            <dt className='text-muted-foreground mb-1 text-xs'>{name}</dt>
            <dd className='text-sm font-medium break-words'>{value}</dd>
          </div>
        ))}
        {row.fallback_reason ? (
          <div className='bg-muted/50 col-span-full rounded-lg p-3'>
            <dt className='text-muted-foreground mb-1 text-xs'>
              {t('Fallback reason')}
            </dt>
            <dd className='text-sm break-words'>{t(row.fallback_reason)}</dd>
          </div>
        ) : null}
      </dl>
    </Dialog>
  )
}

export function TeamUsageTable(props: { rows: TeamUsage[] }) {
  const { t } = useTranslation()
  const label = useUsageLabels()
  const [selected, setSelected] = useState<TeamUsage | null>(null)
  return (
    <>
      <StaticDataTable
        data={props.rows}
        getRowKey={(row) => row.request_id}
        emptyContent={t('No team usage yet')}
        tableProps={{ 'aria-label': t('Usage history') }}
        tableClassName='min-w-[920px]'
        headerRowClassName='bg-muted/40 text-muted-foreground'
        getRowClassName={() => 'hover:bg-muted/30'}
        columns={[
          {
            id: 'actor',
            header: t('Member / API Key'),
            className: 'w-[24%] px-4',
            cellClassName: 'px-4 py-4',
            cell: (row) => (
              <div className='flex max-w-[280px] items-center gap-3'>
                <span
                  aria-hidden
                  className='bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full'
                >
                  {[...(row.username || '?')][0].toUpperCase()}
                </span>
                <div className='min-w-0 space-y-1.5'>
                  <div className='flex min-w-0 items-baseline gap-1.5'>
                    <span
                      className='truncate font-semibold!'
                      title={label.username(row)}
                    >
                      {label.username(row)}
                    </span>
                    {row.username ? (
                      <span
                        data-table-text='secondary'
                        className='text-muted-foreground'
                      >
                        #{row.user_id}
                      </span>
                    ) : null}
                  </div>
                  <div
                    data-table-text='secondary'
                    className='text-muted-foreground flex items-center gap-1.5'
                  >
                    <KeyRound aria-hidden className='size-3 shrink-0' />
                    <span className='truncate' title={label.keyName(row)}>
                      {label.keyName(row)}
                    </span>
                  </div>
                </div>
              </div>
            ),
          },
          {
            id: 'model',
            header: t('Model'),
            className: 'w-[20%]',
            cell: (row) => (
              <div className='max-w-[250px] space-y-2'>
                <Badge
                  variant='outline'
                  className='bg-muted/30 block w-fit max-w-full truncate rounded-md font-semibold!'
                  title={row.model_name}
                >
                  {row.model_name || '-'}
                </Badge>
                <p
                  data-table-text='secondary'
                  className='text-muted-foreground truncate font-mono!'
                  title={row.request_id}
                >
                  {row.using_group ||
                    (row.request_id.length > 18
                      ? `…${row.request_id.slice(-8)}`
                      : row.request_id)}
                </p>
              </div>
            ),
          },
          {
            id: 'tokens',
            header: t('Tokens'),
            cell: (row) => (
              <div
                role='group'
                aria-label={t('Input / output tokens')}
                className='space-y-1.5 tabular-nums'
              >
                <div className='flex items-center gap-1.5'>
                  <span role='img' aria-label={t('Input tokens')}>
                    <ArrowDown
                      aria-hidden
                      className='size-3.5 text-teal-600 dark:text-teal-400'
                    />
                  </span>
                  <span>{formatNumber(row.prompt_tokens)}</span>
                </div>
                <div className='flex items-center gap-1.5'>
                  <span role='img' aria-label={t('Output tokens')}>
                    <ArrowUp
                      aria-hidden
                      className='size-3.5 text-violet-600 dark:text-violet-400'
                    />
                  </span>
                  <span>{formatNumber(row.completion_tokens)}</span>
                </div>
              </div>
            ),
          },
          {
            id: 'actual',
            header: t('Actual cost'),
            cell: (row) => (
              <div className='space-y-1.5'>
                <p className='font-semibold! text-emerald-700 tabular-nums dark:text-emerald-400'>
                  {actualCost(row)}
                </p>
                <Badge
                  variant='outline'
                  data-table-text='secondary'
                  className='bg-muted text-muted-foreground rounded-sm border-0 px-1.5'
                >
                  {label.source(row)}
                </Badge>
              </div>
            ),
          },
          {
            id: 'state',
            header: t('Status'),
            cell: (row) => (
              <Badge variant='outline' className={stateStyles[row.state]}>
                {label.state(row)}
              </Badge>
            ),
          },
          {
            id: 'time',
            header: t('Time'),
            cell: (row) => (
              <time
                dateTime={dayjs.unix(row.created_at).toISOString()}
                className='block space-y-1.5 tabular-nums'
              >
                <span className='block'>
                  {dayjs.unix(row.created_at).format('HH:mm:ss')}
                </span>
                <span
                  data-table-text='secondary'
                  className='text-muted-foreground block'
                >
                  {dayjs.unix(row.created_at).format('YYYY-MM-DD')}
                </span>
              </time>
            ),
          },
          {
            id: 'details',
            header: t('Details'),
            className: 'w-20',
            cell: (row) => (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setSelected(row)}
                className='gap-1 px-2'
              >
                {t('Details')}
                <ChevronRight aria-hidden className='size-3.5' />
              </Button>
            ),
          },
        ]}
      />
      <UsageDetails row={selected} onClose={() => setSelected(null)} />
    </>
  )
}
