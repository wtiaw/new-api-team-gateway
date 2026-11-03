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

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { teamGet, teamWrite } from './api'
import { TeamQueryState } from './query-state'
import type { FundingMode, FundingPolicy, Team } from './types'

export function FundingPolicyDialog(props: {
  tokenId: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const policy = useQuery({
    queryKey: ['teams', 'policy', props.tokenId],
    queryFn: () =>
      teamGet<FundingPolicy>(`/api/team-key-policies/${props.tokenId}`),
    enabled: props.open,
  })
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Funding source')}
    >
      <TeamQueryState query={policy}>
        {(data) => (
          <FundingPolicyForm
            key={`${props.tokenId}-${data.mode}-${data.team_id}`}
            policy={data}
            tokenId={props.tokenId}
            onSaved={() => props.onOpenChange(false)}
          />
        )}
      </TeamQueryState>
    </Dialog>
  )
}
function FundingPolicyForm(props: {
  policy: FundingPolicy
  tokenId: number
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [mode, setMode] = useState<FundingMode>(props.policy.mode)
  const [teamId, setTeamId] = useState(props.policy.team_id)
  const teams = useQuery({
    queryKey: ['teams', 'list'],
    queryFn: () => teamGet<Team[]>('/api/teams'),
  })
  const needsTeam = ['team_only', 'team_first', 'personal_first'].includes(mode)
  const backupDisabled =
    teams.data?.find((team) => team.id === teamId)?.allow_personal_backup ===
    false
  const automatic = mode === 'team_first' || mode === 'personal_first'
  const save = useMutation({
    mutationFn: () =>
      teamWrite('put', `/api/team-key-policies/${props.tokenId}`, {
        mode,
        team_id: needsTeam ? teamId : 0,
      }),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ['teams', 'policy', props.tokenId],
      })
      toast.success(t('Changes saved'))
      props.onSaved()
    },
  })
  return (
    <div className='space-y-4'>
      <Label htmlFor='funding-mode'>{t('Funding source')}</Label>
      <NativeSelect
        id='funding-mode'
        value={mode}
        onChange={(event) => setMode(event.target.value as FundingMode)}
      >
        <NativeSelectOption value='legacy'>
          {t('Keep native funding behavior')}
        </NativeSelectOption>
        <NativeSelectOption value='personal_only'>
          {t('Personal only')}
        </NativeSelectOption>
        <NativeSelectOption value='team_only'>
          {t('Team only')}
        </NativeSelectOption>
        <NativeSelectOption value='team_first' disabled={backupDisabled}>
          {t('Team first, personal backup')}
        </NativeSelectOption>
        <NativeSelectOption value='personal_first' disabled={backupDisabled}>
          {t('Personal first, team backup')}
        </NativeSelectOption>
      </NativeSelect>
      {needsTeam && (
        <TeamQueryState query={teams}>
          {(rows) => (
            <div className='space-y-2'>
              <Label htmlFor='funding-team'>{t('Team')}</Label>
              <NativeSelect
                id='funding-team'
                value={teamId}
                onChange={(event) => setTeamId(Number(event.target.value))}
              >
                <NativeSelectOption value={0}>
                  {t('Select a team')}
                </NativeSelectOption>
                {rows
                  .filter((row) => row.status === 1)
                  .map((row) => (
                    <NativeSelectOption key={row.id} value={row.id}>
                      {row.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </div>
          )}
        </TeamQueryState>
      )}
      <p className='text-muted-foreground text-sm'>
        {t(
          'Existing keys keep native funding behavior until you save a policy. Team limits apply only to team spending.'
        )}
      </p>
      {(mode === 'team_first' || mode === 'personal_first') && (
        <p role='note' className='rounded-lg border p-3 text-sm'>
          {t(
            'Personal backup can spend your personal balance. Personal spending has no daily or weekly limit.'
          )}
        </p>
      )}
      {backupDisabled && (
        <p role='note'>
          {t(
            'This team does not allow automatic switching to personal funds. Choose team only or personal only.'
          )}
        </p>
      )}
      <Button
        disabled={
          save.isPending ||
          (automatic && backupDisabled) ||
          (needsTeam &&
            (!teamId ||
              !teams.data?.some(
                (team) => team.id === teamId && team.status === 1
              )))
        }
        onClick={() => save.mutate()}
      >
        {t('Save changes')}
      </Button>
    </div>
  )
}
