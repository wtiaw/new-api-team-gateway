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
import { useQueries } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Area,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Line,
  Legend,
} from 'recharts'

import { StaticDataTable } from '@/components/data-table'
import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { teamGet } from './api'
import { buildTeamTrendRows, type TeamTrendMetric } from './team-trend-data'
import type { TeamOverviewData } from './types'

export function TeamOverviewCharts(props: {
  teamId: number
  data: TeamOverviewData
  comparedMemberIDs: number[]
  onComparedMembersChange: (ids: number[]) => void
  metric: TeamTrendMetric
  onMetricChange: (metric: TeamTrendMetric) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const metric = props.metric
  const members = props.data.members || []
  const selectedMembers = props.comparedMemberIDs.flatMap((id) =>
    members.filter((member) => member.user_id === id)
  )
  const queries = useQueries({
    queries: selectedMembers.map((member) => ({
      queryKey: [
        'teams',
        props.teamId,
        'overview',
        props.data.days,
        member.user_id,
      ],
      queryFn: () =>
        teamGet<TeamOverviewData>(
          `/api/teams/${props.teamId}/overview?days=${props.data.days}&user_id=${member.user_id}`
        ),
      staleTime: 15_000,
    })),
  })
  const comparing = selectedMembers.length > 0
  const moneyOptions = {
    locale,
    digitsLarge: 6,
    digitsSmall: 6,
    abbreviate: false,
  }
  const dateFormat = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai',
    month: 'short',
    day: 'numeric',
  })
  const labels = {
    requests: t('Requests'),
    actual: t('Actual cost'),
    tokens: t('Tokens'),
  }
  const series = comparing
    ? selectedMembers.map((member, index) => ({
        key: `member_${member.user_id}`,
        label: member.username || `${t('User ID')} #${member.user_id}`,
        color: `var(--chart-${(member.user_id % 5) + 1})`,
        dash: member.user_id >= 5 ? '5 3' : undefined,
        trend: queries[index].data?.trend || [],
      }))
    : [
        {
          key: 'total',
          label: t('Overview'),
          color: 'var(--chart-1)',
          dash: undefined,
          trend: props.data.trend,
        },
      ]
  const config = Object.fromEntries(
    series.map((item) => [item.key, { label: item.label, color: item.color }])
  )
  const trend = buildTeamTrendRows(series, metric, props.data.days).map(
    (day) => ({ ...day, date: dateFormat.format(day.day_start * 1000) })
  )
  const valueText = (value: number) =>
    metric === 'actual'
      ? formatQuotaWithCurrency(value, moneyOptions)
      : formatNumber(value, locale)
  let chart = (
    <ChartContainer
      className='aspect-auto h-64 w-full'
      config={config}
      aria-label={labels[metric]}
    >
      <ComposedChart
        accessibilityLayer
        data={trend}
        margin={{ left: 4, right: 12, top: 12 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey='date'
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          width={metric === 'actual' ? 100 : 65}
          tickLine={false}
          axisLine={false}
          allowDecimals={metric === 'actual'}
          tickFormatter={valueText}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => (
                <>
                  <span
                    className='size-2 shrink-0 rounded-full'
                    style={{ backgroundColor: item.color }}
                    aria-hidden='true'
                  />
                  <span className='text-muted-foreground'>{String(name)}</span>
                  <span className='ml-auto font-mono tabular-nums'>
                    {valueText(Number(value))}
                  </span>
                </>
              )}
            />
          }
        />
        {comparing ? <Legend /> : null}
        {comparing ? (
          series.map((item) => (
            <Line
              key={item.key}
              type='monotone'
              dataKey={item.key}
              name={item.label}
              stroke={`var(--color-${item.key})`}
              strokeWidth={2}
              strokeDasharray={item.dash}
              dot={false}
              isAnimationActive={false}
            />
          ))
        ) : (
          <Area
            type='monotone'
            dataKey='total'
            name={series[0].label}
            stroke='var(--color-total)'
            fill='var(--color-total)'
            fillOpacity={0.15}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  )
  if (comparing && queries.some((query) => query.isPending)) {
    chart = (
      <div className='flex h-64 items-center justify-center' role='status'>
        {t('Loading...')}
      </div>
    )
  }
  if (comparing && queries.some((query) => query.isError)) {
    chart = (
      <div className='flex h-64 flex-col items-center justify-center gap-3'>
        <p role='alert'>{t('Member trends could not be loaded.')}</p>
        <Button
          variant='outline'
          onClick={() =>
            void Promise.all(
              queries
                .filter((query) => query.isError)
                .map((query) => query.refetch())
            )
          }
        >
          {t('Retry')}
        </Button>
      </div>
    )
  }
  return (
    <div className='space-y-4'>
      <section
        className='bg-card min-w-0 rounded-2xl border p-3 sm:p-5'
        aria-label={t('Daily usage trend')}
        aria-busy={queries.some((query) => query.isFetching)}
      >
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
          <h4 className='font-semibold'>{t('Daily usage trend')}</h4>
          <div
            role='group'
            aria-label={t('Trend metric')}
            className='flex flex-wrap gap-1'
          >
            {(['requests', 'actual', 'tokens'] as const).map((item) => (
              <Button
                key={item}
                size='sm'
                variant={metric === item ? 'default' : 'outline'}
                aria-pressed={metric === item}
                onClick={() => props.onMetricChange(item)}
              >
                {labels[item]}
              </Button>
            ))}
          </div>
        </div>
        {members.length > 0 && (
          <div className='mb-4 space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <label
                htmlFor={`trend-members-${props.teamId}`}
                className='text-sm'
              >
                {t('Compare members')}
              </label>
              <MultiSelect
                id={`trend-members-${props.teamId}`}
                className='min-w-56 flex-1 sm:max-w-md'
                options={members.map((member) => ({
                  value: String(member.user_id),
                  label:
                    member.username || `${t('User ID')} #${member.user_id}`,
                }))}
                selected={selectedMembers.map((member) =>
                  String(member.user_id)
                )}
                onChange={(values) =>
                  props.onComparedMembersChange(
                    values
                      .map(Number)
                      .filter((id) =>
                        members.some((member) => member.user_id === id)
                      )
                  )
                }
                placeholder={t('Compare members')}
                allowCreate={false}
                maxVisibleChips={3}
              />
              <Button
                size='sm'
                variant='outline'
                disabled={!comparing}
                onClick={() => props.onComparedMembersChange([])}
              >
                {t('Reset comparison')}
              </Button>
            </div>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Member comparisons only affect this chart. Clear the selection to follow the overview filter.'
              )}
            </p>
          </div>
        )}
        {chart}
      </section>
      <section className='min-w-0 space-y-3' aria-label={t('Usage by model')}>
        <h4 className='font-semibold'>{t('Usage by model')}</h4>
        <StaticDataTable
          data={props.data.models}
          getRowKey={(row) => row.model_name}
          emptyContent={t('No team usage yet')}
          tableProps={{ 'aria-label': t('Usage by model') }}
          columns={[
            {
              id: 'model',
              header: t('Model'),
              cell: (row) => row.model_name || t('Unknown'),
            },
            {
              id: 'requests',
              header: t('Requests'),
              cell: (row) => formatNumber(row.requests, locale),
            },
            {
              id: 'actual',
              header: t('Actual cost'),
              cell: (row) => formatQuotaWithCurrency(row.actual, moneyOptions),
            },
            {
              id: 'input',
              header: t('Input tokens'),
              cell: (row) => formatNumber(row.prompt_tokens, locale),
            },
            {
              id: 'output',
              header: t('Output tokens'),
              cell: (row) => formatNumber(row.completion_tokens, locale),
            },
          ]}
        />
      </section>
    </div>
  )
}
