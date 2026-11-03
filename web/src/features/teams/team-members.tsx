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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StaticDataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'

import { teamGet, useTeamMutation } from './api'
import { TeamQueryState } from './query-state'
import type { TeamMember } from './types'

export function TeamMembers(props: { teamId: number; system: boolean }) {
  const { t } = useTranslation()
  const [action, setAction] = useState<{
    member: TeamMember
    kind: 'remove' | 'status' | 'role'
  } | null>(null)
  const members = useQuery({
    queryKey: ['teams', props.teamId, 'members'],
    queryFn: () => teamGet<TeamMember[]>(`/api/teams/${props.teamId}/members`),
  })
  const save = useTeamMutation(() => setAction(null))
  return (
    <>
      <p className='text-muted-foreground my-3 text-sm'>
        {t(
          'Membership changes affect this team only. Personal balances and accounts stay independent.'
        )}
      </p>
      <TeamQueryState query={members}>
        {(rows) => (
          <StaticDataTable
            data={rows}
            getRowKey={(row) => row.id}
            emptyContent={t('No members')}
            columns={[
              {
                id: 'user',
                header: t('Member'),
                cell: (row) =>
                  `${row.display_name || row.username} (#${row.user_id})`,
              },
              {
                id: 'role',
                header: t('Role'),
                cell: (row) =>
                  row.role === 'admin' ? t('Team administrator') : t('Member'),
              },
              {
                id: 'status',
                header: t('Status'),
                cell: (row) =>
                  row.status === 1 ? t('Enabled') : t('Disabled'),
              },
              {
                id: 'actions',
                header: t('Actions'),
                cell: (row) => (
                  <div className='flex flex-wrap gap-2'>
                    {(props.system || row.role !== 'admin') && (
                      <>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={save.isPending}
                          onClick={() =>
                            setAction({ member: row, kind: 'status' })
                          }
                        >
                          {row.status === 1 ? t('Disable') : t('Enable')}
                        </Button>
                        <Button
                          size='sm'
                          variant='destructive'
                          disabled={save.isPending}
                          onClick={() =>
                            setAction({ member: row, kind: 'remove' })
                          }
                        >
                          {t('Remove member')}
                        </Button>
                      </>
                    )}
                    {props.system && (
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => setAction({ member: row, kind: 'role' })}
                      >
                        {row.role === 'admin'
                          ? t('Revoke administrator')
                          : t('Appoint administrator')}
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </TeamQueryState>
      <ConfirmDialog
        open={!!action}
        onOpenChange={(open) => !open && setAction(null)}
        title={t('Confirm membership change')}
        desc={
          action
            ? `${action.member.username}: ${t('Membership changes affect this team only. Personal balances and accounts stay independent.')}`
            : ''
        }
        destructive={action?.kind === 'remove'}
        isLoading={save.isPending}
        handleConfirm={() => {
          if (!action) return
          const path = `/api/teams/${props.teamId}/members/${action.member.user_id}`
          if (action.kind === 'remove') {
            save.mutate({ method: 'delete', path })
            return
          }
          const body =
            action.kind === 'role'
              ? { role: action.member.role === 'admin' ? 'member' : 'admin' }
              : { status: action.member.status === 1 ? 2 : 1 }
          save.mutate({ method: 'put', path, body })
        }}
      />
    </>
  )
}
