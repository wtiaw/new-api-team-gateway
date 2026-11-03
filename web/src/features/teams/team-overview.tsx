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
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Activity, Coins, Layers } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { formatNumber } from '@/lib/format'

import { teamGet } from './api'
import { TeamQueryState } from './query-state'
import { TeamBudget } from './team-budget'
import { TeamOverviewCharts } from './team-overview-charts'
import type { TeamTrendMetric } from './team-trend-data'
import type { TeamDetail, TeamOverviewData } from './types'

export function TeamOverview(props: { teamId: number; detail?: TeamDetail }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const [days, setDays] = useState<7 | 30>(7)
  const [memberID, setMemberID] = useState(0)
  const [comparedMemberIDs, setComparedMemberIDs] = useState<number[]>([])
  const [trendMetric, setTrendMetric] = useState<TeamTrendMetric>('requests')
  const selectedMemberID = props.detail?.role === 'member' ? 0 : memberID
  const overview = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['teams', props.teamId, 'overview', days, selectedMemberID],
    queryFn: () =>
      teamGet<TeamOverviewData>(
        `/api/teams/${props.teamId}/overview?days=${days}${selectedMemberID > 0 ? `&user_id=${selectedMemberID}` : ''}`
      ),
  })
  const canFilter = props.detail
    ? props.detail.role === 'admin' || props.detail.role === 'system'
    : overview.data?.scope !== 'mine'
  const scope = overview.data?.scope || 'team'
  let heading = scope === 'mine' ? t('My team usage') : t('Team usage')
  if (scope === 'member') {
    const member = overview.data?.members?.find(
      (item) => item.user_id === overview.data?.member_id
    )
    heading += ` · ${member?.username || overview.data?.member_id}`
  }
  const description = {
    mine: t('Only your requests funded by this team are shown.'),
    team: t('Requests funded by this team across all members.'),
    member: t('Requests funded by this team for the selected member.'),
  }[scope]
  const moneyOptions = {
    locale,
    digitsLarge: 6,
    digitsSmall: 6,
    abbreviate: false,
  }
  return (
    <section className='min-w-0 space-y-4' aria-label={t('Overview')}>
      <h3 className='text-base font-semibold'>{t('Overview')}</h3>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div role='group' aria-label={t('Time range')} className='flex gap-2'>
          <Button
            variant={days === 7 ? 'default' : 'outline'}
            aria-pressed={days === 7}
            onClick={() => setDays(7)}
          >
            {t('Last 7 days')}
          </Button>
          <Button
            variant={days === 30 ? 'default' : 'outline'}
            aria-pressed={days === 30}
            onClick={() => setDays(30)}
          >
            {t('Last 30 days')}
          </Button>
        </div>
        {canFilter && overview.data?.members && (
          <label className='flex items-center gap-2 text-sm'>
            <span>{t('Member')}</span>
            <NativeSelect
              aria-label={t('Member')}
              value={selectedMemberID}
              onChange={(event) => setMemberID(Number(event.target.value))}
            >
              <NativeSelectOption value='0'>
                {t('All members')}
              </NativeSelectOption>
              {overview.data.members.map((member) => (
                <NativeSelectOption key={member.user_id} value={member.user_id}>
                  {member.username || `${t('User ID')} #${member.user_id}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        {canFilter && overview.isError && selectedMemberID > 0 && (
          <Button variant='outline' onClick={() => setMemberID(0)}>
            {t('All members')}
          </Button>
        )}
        <Button
          variant='outline'
          disabled={overview.isFetching}
          aria-busy={overview.isFetching}
          onClick={() =>
            void client.invalidateQueries({ queryKey: ['teams', props.teamId] })
          }
        >
          {t('Refresh usage')}
        </Button>
      </div>
      <div className='bg-card space-y-4 rounded-2xl border p-3 sm:p-5'>
        {props.detail && (
          <TeamBudget
            detail={props.detail}
            selectedMember={selectedMemberID > 0}
            memberUsage={
              !overview.isError &&
              !overview.isPlaceholderData &&
              (overview.data?.scope === 'mine' ||
                overview.data?.scope === 'member')
                ? overview.data.period_usage
                : undefined
            }
          />
        )}
        <TeamQueryState query={overview}>
          {(data) =>
            overview.isPlaceholderData ? (
              <p role='status'>{t('Loading...')}</p>
            ) : (
              <>
                <div>
                  <h3 className='text-base font-semibold'>{heading}</h3>
                  <p className='text-muted-foreground text-sm'>{description}</p>
                  <p className='text-muted-foreground text-xs'>
                    {t('Usage dates use Asia/Shanghai.')}
                  </p>
                </div>
                <div className='grid gap-4 sm:grid-cols-3'>
                  <StatCard
                    title={t('Requests')}
                    value={formatNumber(data.summary.requests, locale)}
                    description={t('All request attempts')}
                    icon={Activity}
                    tone='accent-1'
                    details={[
                      {
                        label: t('settled'),
                        value: formatNumber(
                          data.summary.settled_requests,
                          locale
                        ),
                      },
                      {
                        label: t('refunded'),
                        value: formatNumber(
                          data.summary.refunded_requests,
                          locale
                        ),
                      },
                    ]}
                  />
                  <StatCard
                    title={t('Actual cost')}
                    value={formatQuotaWithCurrency(
                      data.summary.actual,
                      moneyOptions
                    )}
                    description={t('Settled requests only')}
                    icon={Coins}
                    tone='accent-2'
                  />
                  <StatCard
                    title={t('Tokens')}
                    value={formatNumber(
                      data.summary.prompt_tokens +
                        data.summary.completion_tokens,
                      locale
                    )}
                    description={t('Settled requests only')}
                    icon={Layers}
                    tone='accent-3'
                    details={[
                      {
                        label: t('Input tokens'),
                        value: formatNumber(data.summary.prompt_tokens, locale),
                      },
                      {
                        label: t('Output tokens'),
                        value: formatNumber(
                          data.summary.completion_tokens,
                          locale
                        ),
                      },
                    ]}
                  />
                </div>
                {data.summary.requests === 0 && (
                  <EmptyState
                    bordered
                    title={t('No team usage yet')}
                    description={t(
                      'No requests in this time range. Try a longer range or send a request using this team.'
                    )}
                  />
                )}
                {(data.summary.requests > 0 ||
                  (canFilter && !!data.members?.length)) && (
                  <TeamOverviewCharts
                    teamId={props.teamId}
                    data={data}
                    comparedMemberIDs={comparedMemberIDs}
                    onComparedMembersChange={setComparedMemberIDs}
                    metric={trendMetric}
                    onMetricChange={setTrendMetric}
                  />
                )}
              </>
            )
          }
        </TeamQueryState>
      </div>
    </section>
  )
}
