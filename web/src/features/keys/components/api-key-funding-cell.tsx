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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { teamGet, teamWrite } from '@/features/teams/api'
import type { FundingMode, Team } from '@/features/teams/types'
import { handleServerError } from '@/lib/handle-server-error'

import type { ApiKey } from '../types'

export function ApiKeyFundingCell(props: { apiKey: ApiKey }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [chosenTeam, setChosenTeam] = useState<number>()
  const teams = useQuery({
    queryKey: ['teams', 'list'],
    queryFn: () => teamGet<Team[]>('/api/teams'),
  })
  const policy = props.apiKey.funding_policy
  const activeTeams = (teams.data ?? []).filter((team) => team.status === 1)
  const teamId =
    (chosenTeam ?? policy?.team_id) ||
    (activeTeams.length === 1 ? activeTeams[0].id : 0)
  const selectedTeam = activeTeams.find((team) => team.id === teamId)
  const save = useMutation({
    mutationFn: (value: { mode: FundingMode; team_id: number }) =>
      teamWrite('put', `/api/team-key-policies/${props.apiKey.id}`, value),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['keys'] })
      void client.invalidateQueries({
        queryKey: ['teams', 'policy', props.apiKey.id],
      })
      toast.success(t('Changes saved'))
    },
    onError: (error) => {
      setChosenTeam(undefined)
      handleServerError(error)
    },
  })
  const mode = save.isPending ? save.variables.mode : (policy?.mode ?? 'legacy')
  const teamMode =
    mode === 'team_only' || mode === 'team_first' || mode === 'personal_first'
  const automaticDisabled =
    !selectedTeam || selectedTeam.allow_personal_backup === false
  let status = ''
  if (save.isPending) status = t('Saving...')
  else if (policy?.is_default) status = t('Default')
  return (
    <div className='min-w-40 space-y-1.5' aria-busy={save.isPending}>
      <NativeSelect
        size='sm'
        className='w-full'
        aria-label={`${t('Funding source')}: ${props.apiKey.name}`}
        value={mode}
        disabled={save.isPending}
        onChange={(event) => {
          const next = event.target.value as FundingMode
          const needsTeam =
            next === 'team_only' ||
            next === 'team_first' ||
            next === 'personal_first'
          if (needsTeam && !selectedTeam) return
          save.mutate({ mode: next, team_id: needsTeam ? teamId : 0 })
        }}
      >
        <NativeSelectOption value='legacy'>
          {t('Automatic (team first)')}
        </NativeSelectOption>
        <NativeSelectOption value='team_first' disabled={automaticDisabled}>
          {t('Team first, personal backup')}
        </NativeSelectOption>
        <NativeSelectOption value='personal_first' disabled={automaticDisabled}>
          {t('Personal first, team backup')}
        </NativeSelectOption>
        <NativeSelectOption value='team_only' disabled={!selectedTeam}>
          {t('Team only')}
        </NativeSelectOption>
        <NativeSelectOption value='personal_only'>
          {t('Personal only')}
        </NativeSelectOption>
      </NativeSelect>
      {activeTeams.length > 1 && (
        <NativeSelect
          size='sm'
          className='w-full'
          aria-label={`${t('Team')}: ${props.apiKey.name}`}
          value={teamId}
          disabled={save.isPending}
          onChange={(event) => {
            const id = Number(event.target.value)
            setChosenTeam(id)
            if (teamMode && id) save.mutate({ mode, team_id: id })
          }}
        >
          <NativeSelectOption value={0} disabled>
            {t('Select a team')}
          </NativeSelectOption>
          {activeTeams.map((team) => (
            <NativeSelectOption key={team.id} value={team.id}>
              {team.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <div className='text-muted-foreground text-xs'>
        {status}
        {!save.isPending && teamMode && selectedTeam && (
          <span className='ml-1'>{selectedTeam.name}</span>
        )}
      </div>
      {teams.isError && (
        <Button variant='ghost' size='sm' onClick={() => void teams.refetch()}>
          {t('Retry')}
        </Button>
      )}
    </div>
  )
}
