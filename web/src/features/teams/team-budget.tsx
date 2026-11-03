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
import { CalendarDays, CalendarRange, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StatCard } from '@/features/dashboard/components/ui/stat-card'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'

import type { TeamDetail } from './types'

export function TeamBudget(props: {
  detail: TeamDetail
  memberUsage?: TeamDetail['budget']
  selectedMember?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const moneyOptions = {
    locale,
    digitsLarge: 6,
    digitsSmall: 6,
    abbreviate: false,
  }
  const team = props.detail.team
  const budget = props.detail.budget
  const manage = props.detail.role === 'admin' || props.detail.role === 'system'
  const showMemberUsage = !manage || props.selectedMember
  const limits = [
    {
      key: 'daily',
      label: t('Daily team allowance per member'),
      limit: team.daily_limit,
      icon: CalendarDays,
      used: props.memberUsage?.daily_used,
      reserved: props.memberUsage?.daily_reserved ?? 0,
      ownLabel: manage
        ? t('Selected member spending today')
        : t('My spending today'),
    },
    {
      key: 'weekly',
      label: t('Weekly team allowance per member'),
      limit: team.weekly_limit,
      icon: CalendarRange,
      used: props.memberUsage?.weekly_used,
      reserved: props.memberUsage?.weekly_reserved ?? 0,
      ownLabel: manage
        ? t('Selected member spending this week')
        : t('My spending this week'),
    },
  ]
  const calendar = budget || props.memberUsage
  const cycleDate = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return (
    <section
      className='space-y-3 border-b pb-4'
      aria-label={t('Team spending limits')}
    >
      <h3 className='text-sm font-semibold'>
        {manage ? t('Shared team budget') : t('Team spending limits')}
      </h3>
      <div
        className={
          manage
            ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3'
            : 'grid gap-4 sm:grid-cols-2'
        }
      >
        {manage && team.balance != null && (
          <StatCard
            title={t('Shared balance')}
            value={formatQuotaWithCurrency(team.balance, moneyOptions)}
            description={t('Team balance')}
            icon={Wallet}
            tone='accent-1'
            details={
              budget
                ? [
                    {
                      label: t('Team spending today'),
                      value: formatQuotaWithCurrency(
                        budget.daily_used,
                        moneyOptions
                      ),
                    },
                    {
                      label: t('Team spending this week'),
                      value: formatQuotaWithCurrency(
                        budget.weekly_used,
                        moneyOptions
                      ),
                    },
                  ]
                : undefined
            }
          />
        )}
        {limits.map((period) => {
          const used =
            period.used == null
              ? '—'
              : formatQuotaWithCurrency(period.used, moneyOptions)
          let remaining = '—'
          if (period.limit == null) remaining = t('Unlimited')
          else if (period.used != null) {
            remaining = formatQuotaWithCurrency(
              period.limit - period.used - period.reserved,
              moneyOptions
            )
          }
          return (
            <StatCard
              key={period.key}
              title={period.label}
              value={
                period.limit == null
                  ? t('Unlimited')
                  : formatQuotaWithCurrency(period.limit, moneyOptions)
              }
              description={t(
                'Each member has a separate allowance for team-funded requests.'
              )}
              icon={period.icon}
              tone='accent-2'
              details={
                showMemberUsage
                  ? [
                      { label: period.ownLabel, value: used },
                      {
                        label: t('Remaining member allowance'),
                        value: remaining,
                      },
                    ]
                  : undefined
              }
            />
          )
        })}
      </div>
      {calendar && (
        <p className='text-muted-foreground text-xs'>
          {t('Team cycles use Asia/Shanghai. Daily reset / weekly reset')}:{' '}
          {cycleDate.format((calendar.day_start + 86400) * 1000)} /{' '}
          {cycleDate.format((calendar.week_start + 7 * 86400) * 1000)}
        </p>
      )}
      <p className='text-muted-foreground text-xs'>
        {t(
          'These daily and weekly allowances apply separately to each member using team funds. Personal balance has no daily or weekly cap.'
        )}
      </p>
    </section>
  )
}
