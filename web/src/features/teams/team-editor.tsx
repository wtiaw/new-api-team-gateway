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
import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'

import { useTeamMutation } from './api'
import { TEAM_QUOTA_PER_USD, usdToQuota } from './quota'
import { TeamAdminPicker } from './team-admin-picker'
import { TeamGroupSettings } from './team-group-settings'
import type { Team } from './types'

const amount = z.string().refine((value) => {
  try {
    usdToQuota(value)
    return true
  } catch {
    return false
  }
}, 'Enter a valid non-negative USD amount')
const schema = z.object({
  name: z.string().trim().min(1).max(100),
  daily: amount,
  weekly: amount,
  admin: z
    .string()
    .refine(
      (value) =>
        !value || (Number.isSafeInteger(Number(value)) && Number(value) > 0),
      'Enter a valid user ID'
    ),
  status: z.string(),
  allowPersonalBackup: z.boolean(),
  allowedGroups: z.array(z.string()),
  defaultGroup: z.string(),
})
export function TeamEditor(props: {
  team?: Team
  system: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: props.team?.name ?? '',
      daily:
        props.team?.daily_limit == null
          ? ''
          : String(props.team.daily_limit / TEAM_QUOTA_PER_USD),
      weekly:
        props.team?.weekly_limit == null
          ? ''
          : String(props.team.weekly_limit / TEAM_QUOTA_PER_USD),
      admin: '',
      status: String(props.team?.status ?? 1),
      allowPersonalBackup: props.team?.allow_personal_backup ?? true,
      allowedGroups: props.team?.allowed_groups ?? [],
      defaultGroup: props.team?.default_group ?? '',
    },
  })
  const save = useTeamMutation(() => props.onOpenChange(false))
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.team ? t('Team settings') : t('Create team')}
    >
      <form
        className='space-y-4'
        onSubmit={form.handleSubmit((values) => {
          const body: Record<string, unknown> = {
            name: values.name,
            daily_limit: usdToQuota(values.daily),
            weekly_limit: usdToQuota(values.weekly),
          }
          if (
            props.system &&
            values.allowedGroups.length > 0 &&
            !values.allowedGroups.includes(values.defaultGroup)
          ) {
            form.setError('defaultGroup', {
              message: 'Select a default from the allowed team groups',
            })
            return
          }
          if (props.system) {
            body.allowed_groups = values.allowedGroups
            body.default_group = values.defaultGroup
            body.allow_personal_backup = values.allowPersonalBackup
            body.status = Number(values.status)
            if (values.admin) body.admin_user_id = Number(values.admin)
          }
          if (!props.team && !values.admin) {
            form.setError('admin', {
              message: 'Select a user from the search results',
            })
            return
          }
          save.mutate({
            method: props.team ? 'put' : 'post',
            path: props.team ? `/api/teams/${props.team.id}` : '/api/teams',
            body,
          })
        })}
      >
        <div className='space-y-2'>
          <Label htmlFor='team-name'>{t('Team name')}</Label>
          <Input
            id='team-name'
            {...form.register('name')}
            aria-invalid={!!form.formState.errors.name}
          />
          {form.formState.errors.name && (
            <p role='alert'>
              {t('Team name is required (up to 100 characters).')}
            </p>
          )}
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          {(['daily', 'weekly'] as const).map((period) => (
            <div key={period} className='space-y-2'>
              <Label htmlFor={`team-${period}`}>
                {period === 'daily'
                  ? t('Daily team allowance per member (USD)')
                  : t('Weekly team allowance per member (USD)')}
              </Label>
              <Input
                id={`team-${period}`}
                inputMode='decimal'
                {...form.register(period)}
                aria-invalid={!!form.formState.errors[period]}
              />
              {form.formState.errors[period] && (
                <p role='alert'>{t('Enter a valid non-negative USD amount')}</p>
              )}
            </div>
          ))}
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Each member has separate daily and weekly team allowances. Leave blank for unlimited; zero disables team spending for each member. Personal balance is unaffected.'
          )}
        </p>
        {props.system && (
          <>
            <div className='space-y-2'>
              <Label htmlFor='team-admin'>{t('Team administrator')}</Label>
              <Controller
                control={form.control}
                name='admin'
                render={({ field }) => (
                  <TeamAdminPicker
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    invalid={!!form.formState.errors.admin}
                  />
                )}
              />
              {form.formState.errors.admin && (
                <p role='alert'>{t('Select a user from the search results')}</p>
              )}
            </div>
            {props.team && (
              <div className='space-y-2'>
                <Label htmlFor='team-status'>{t('Status')}</Label>
                <NativeSelect id='team-status' {...form.register('status')}>
                  <NativeSelectOption value='1'>
                    {t('Enabled')}
                  </NativeSelectOption>
                  <NativeSelectOption value='2'>
                    {t('Disabled')}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
            )}
          </>
        )}
        <TeamGroupSettings
          system={props.system}
          value={{
            allowed_groups: form.watch('allowedGroups'),
            default_group: form.watch('defaultGroup'),
          }}
          onChange={(value) => {
            form.setValue('allowedGroups', value.allowed_groups)
            form.setValue('defaultGroup', value.default_group)
            form.clearErrors('defaultGroup')
          }}
          error={form.formState.errors.defaultGroup?.message}
        />
        <div className='flex items-center gap-3'>
          <Switch
            id='team-personal-backup'
            checked={form.watch('allowPersonalBackup')}
            disabled={!props.system}
            onCheckedChange={(checked) =>
              form.setValue('allowPersonalBackup', checked)
            }
          />
          <Label htmlFor='team-personal-backup'>
            {t('Allow personal backup')}
          </Label>
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Only system administrators can change whether this team allows automatic switching to personal funds.'
          )}
        </p>
        <Button type='submit' disabled={save.isPending}>
          {t('Save changes')}
        </Button>
      </form>
    </Dialog>
  )
}
