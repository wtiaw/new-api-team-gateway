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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { teamGet } from './api'
import { BalanceDialog } from './balance-dialog'
import { TeamQueryState } from './query-state'
import { TeamEditor } from './team-editor'
import { TeamGroupSummary } from './team-group-settings'
import { TeamInvitations } from './team-invitations'
import { TeamMembers } from './team-members'
import { TeamOverview } from './team-overview'
import { TeamRecords } from './team-records'
import type { TeamDetail } from './types'

export function TeamDetailView(props: {
  teamId: number
  system: boolean
  onBack?: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [edit, setEdit] = useState(false)
  const [balance, setBalance] = useState(false)
  const detail = useQuery({
    queryKey: ['teams', props.teamId, 'detail'],
    queryFn: () => teamGet<TeamDetail>(`/api/teams/${props.teamId}`),
  })
  return (
    <div className='space-y-6'>
      {props.onBack && (
        <Button variant='outline' onClick={props.onBack}>
          {t('All teams')}
        </Button>
      )}
      <TeamQueryState query={detail}>
        {(data) => {
          const manage = data.role === 'admin' || data.role === 'system'
          return (
            <>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <h2 className='max-w-full truncate text-xl font-semibold'>
                  {data.team.name}
                </h2>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    disabled={detail.isFetching}
                    aria-busy={detail.isFetching}
                    onClick={() =>
                      void client.invalidateQueries({
                        queryKey: ['teams', props.teamId],
                      })
                    }
                  >
                    {manage ? t('Refresh balance') : t('Refresh overview')}
                  </Button>
                  {manage && (
                    <Button variant='outline' onClick={() => setEdit(true)}>
                      {t('Team settings')}
                    </Button>
                  )}
                  {data.role === 'system' && (
                    <Button onClick={() => setBalance(true)}>
                      {t('Adjust team balance')}
                    </Button>
                  )}
                </div>
              </div>
              <TeamOverview
                key={props.teamId}
                teamId={props.teamId}
                detail={data}
              />
              <TeamGroupSummary team={data.team} />
              {manage && (
                <section
                  aria-label={t('Members')}
                  className='min-w-0 space-y-3'
                >
                  <h3 className='text-base font-semibold'>{t('Members')}</h3>
                  <TeamMembers
                    teamId={props.teamId}
                    system={data.role === 'system'}
                  />
                </section>
              )}
              {manage && (
                <section
                  aria-label={t('Invitations')}
                  className='min-w-0 space-y-3'
                >
                  <h3 className='text-base font-semibold'>
                    {t('Invitations')}
                  </h3>
                  <TeamInvitations teamId={props.teamId} />
                </section>
              )}
              {manage && (
                <section
                  aria-label={t('Usage history')}
                  className='min-w-0 space-y-3'
                >
                  <h3 className='text-base font-semibold'>
                    {t('Usage history')}
                  </h3>
                  <TeamRecords teamId={props.teamId} kind='usage' />
                </section>
              )}
              {manage && (
                <section
                  aria-label={t('Balance history')}
                  className='min-w-0 space-y-3'
                >
                  <h3 className='text-base font-semibold'>
                    {t('Balance history')}
                  </h3>
                  <TeamRecords teamId={props.teamId} kind='quota' />
                </section>
              )}
              {edit && manage && (
                <TeamEditor
                  team={data.team}
                  system={data.role === 'system'}
                  open
                  onOpenChange={setEdit}
                />
              )}
              {balance && data.role === 'system' && (
                <BalanceDialog
                  teamId={props.teamId}
                  open
                  onOpenChange={setBalance}
                />
              )}
            </>
          )
        }}
      </TeamQueryState>
    </div>
  )
}
