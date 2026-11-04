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
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { MultiSelect } from '@/components/multi-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { teamGet } from './api'
import type { Team } from './types'

interface TeamGroupValue {
  allowed_groups: string[]
  default_group: string
}

export function TeamGroupSummary(props: {
  team: Pick<Team, 'allowed_groups' | 'default_group'>
}) {
  const { t } = useTranslation()
  const groups = props.team.allowed_groups || []
  return (
    <section
      aria-label={t('Team routing groups')}
      className='space-y-2 rounded-lg border p-4'
    >
      <h3 className='text-sm font-semibold'>{t('Team routing groups')}</h3>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Personal and team payments use the same team-authorized groups. Changing the payer does not change the selected group.'
        )}
      </p>
      {groups.length ? (
        <div className='flex flex-wrap gap-2'>
          {groups.map((group) => (
            <Badge key={group} variant='outline'>
              <span>{group}</span>
              {group === props.team.default_group ? (
                <span className='text-muted-foreground ml-1'>
                  {t('Default selection')}
                </span>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : (
        <p className='text-muted-foreground text-sm'>
          {t(
            'No groups granted. Members cannot call models until groups are assigned.'
          )}
        </p>
      )}
    </section>
  )
}

export function TeamGroupSettings(props: {
  system: boolean
  value: TeamGroupValue
  onChange: (value: TeamGroupValue) => void
  error?: string
}) {
  const { t } = useTranslation()
  const options = useQuery({
    queryKey: ['team-group-options'],
    enabled: props.system,
    queryFn: async () => {
      const data = await teamGet<unknown>('/api/group/')
      if (!Array.isArray(data)) throw new Error('Failed to load groups')
      return data.filter(
        (group): group is string =>
          typeof group === 'string' && group !== 'auto'
      )
    },
  })
  if (!props.system) return <TeamGroupSummary team={props.value} />
  return (
    <section
      aria-label={t('Team routing groups')}
      className='space-y-3 rounded-lg border p-4'
    >
      <h3 className='text-sm font-semibold'>{t('Team routing groups')}</h3>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Only system administrators grant groups. Personal and team payments share these groups; users without a team have no group access.'
        )}
      </p>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Each resource group belongs to one team. Users can join multiple teams.'
        )}
      </p>
      {options.isError ? (
        <ErrorState
          title={t('Failed to load groups')}
          action={
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => {
                void options.refetch()
              }}
            >
              {t('Retry')}
            </Button>
          }
          className='min-h-0 p-2'
        />
      ) : null}
      <div className='space-y-2'>
        <Label htmlFor='team-allowed-groups'>{t('Team allowed groups')}</Label>
        <MultiSelect
          id='team-allowed-groups'
          options={(options.data || []).map((group) => ({
            label: group,
            value: group,
          }))}
          selected={props.value.allowed_groups}
          onChange={(groups) =>
            props.onChange({
              allowed_groups: groups,
              default_group: groups.includes(props.value.default_group)
                ? props.value.default_group
                : '',
            })
          }
          placeholder={t('Team allowed groups')}
          allowCreate={false}
          disabled={options.isPending || options.isError}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='team-default-group'>{t('Default team group')}</Label>
        <NativeSelect
          id='team-default-group'
          value={props.value.default_group}
          onChange={(event) =>
            props.onChange({
              ...props.value,
              default_group: event.target.value,
            })
          }
          aria-invalid={!!props.error}
        >
          <NativeSelectOption value=''>
            {t('Select a group')}
          </NativeSelectOption>
          {props.value.allowed_groups.map((group) => (
            <NativeSelectOption key={group} value={group}>
              {group}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className='text-muted-foreground text-xs'>
          {t(
            'The default selection must be an allowed group, such as Development. It does not create a group named default.'
          )}
        </p>
        {props.error ? (
          <p role='alert' className='text-destructive text-sm'>
            {t(props.error)}
          </p>
        ) : null}
      </div>
    </section>
  )
}
