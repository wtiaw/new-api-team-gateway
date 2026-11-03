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
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { handleServerError } from '@/lib/handle-server-error'

import { teamGet, teamWrite, useTeamMutation } from './api'
import { TeamQueryState } from './query-state'
import type { TeamInvitation } from './types'

export function TeamInvitations(props: { teamId: number }) {
  const { t } = useTranslation()
  const [days, setDays] = useState('7')
  const [creating, setCreating] = useState(false)
  const [link, setLink] = useState('')
  const [revokeId, setRevokeId] = useState<number | null>(null)
  const invitations = useQuery({
    queryKey: ['teams', props.teamId, 'invitations'],
    queryFn: () =>
      teamGet<TeamInvitation[]>(`/api/teams/${props.teamId}/invitations`),
  })
  const revoke = useTeamMutation(() => setRevokeId(null))
  // Secret-bearing responses never enter React Query's mutation/query caches.
  const create = async () => {
    setCreating(true)
    try {
      const result = await teamWrite<{ token: string }>(
        'post',
        `/api/teams/${props.teamId}/invitations`,
        { valid_days: Number(days) }
      )
      setLink(
        `${window.location.origin}/team-invitation/${encodeURIComponent(result.token)}`
      )
      await invitations.refetch()
    } catch (error) {
      handleServerError(error)
    } finally {
      setCreating(false)
    }
  }
  return (
    <div className='space-y-4 py-3'>
      <div className='flex flex-wrap items-end gap-3'>
        <div className='space-y-2'>
          <Label htmlFor='invite-days'>{t('Invitation validity (days)')}</Label>
          <Input
            id='invite-days'
            className='w-28'
            type='number'
            min={1}
            max={30}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </div>
        <Button
          disabled={
            creating ||
            !Number.isInteger(Number(days)) ||
            Number(days) < 1 ||
            Number(days) > 30
          }
          onClick={() => void create()}
        >
          {t('Generate invitation')}
        </Button>
      </div>
      <TeamQueryState query={invitations}>
        {(rows) => (
          <StaticDataTable
            data={rows}
            getRowKey={(row) => row.id}
            emptyContent={t('No invitations yet')}
            columns={[
              { id: 'id', header: t('ID'), cell: (row) => row.id },
              {
                id: 'expiry',
                header: t('Expires at'),
                cell: (row) =>
                  dayjs.unix(row.expired_at).format('YYYY-MM-DD HH:mm'),
              },
              {
                id: 'state',
                header: t('Status'),
                cell: (row) => {
                  if (row.revoked_at) return t('Revoked')
                  if (row.used_at) return t('Accepted')
                  if (row.expired_at * 1000 < Date.now()) return t('Expired')
                  return t('Active')
                },
              },
              {
                id: 'acceptedBy',
                header: t('Accepted by'),
                cell: (row) =>
                  row.used_by
                    ? row.accepted_username || `${t('User ID')} #${row.used_by}`
                    : '—',
              },
              {
                id: 'acceptedAt',
                header: t('Accepted at'),
                cell: (row) =>
                  row.used_at
                    ? dayjs.unix(row.used_at).format('YYYY-MM-DD HH:mm:ss')
                    : '—',
              },
              {
                id: 'actions',
                header: t('Actions'),
                cell: (row) => (
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={
                      !!row.revoked_at || !!row.used_at || revoke.isPending
                    }
                    onClick={() => setRevokeId(row.id)}
                  >
                    {t('Revoke invitation')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </TeamQueryState>
      <Dialog
        open={!!link}
        onOpenChange={(open) => !open && setLink('')}
        title={t('Invitation created')}
        description={t(
          'Copy this one-time link now. It will not be shown again.'
        )}
      >
        <CopyButton
          value={link}
          size='default'
          variant='outline'
          aria-label={t('Copy invitation link')}
        >
          {t('Copy invitation link')}
        </CopyButton>
      </Dialog>
      <ConfirmDialog
        open={revokeId !== null}
        onOpenChange={(open) => !open && setRevokeId(null)}
        title={t('Revoke invitation')}
        desc={t('This invitation link will no longer allow anyone to join.')}
        destructive
        isLoading={revoke.isPending}
        handleConfirm={() =>
          revoke.mutate({
            method: 'delete',
            path: `/api/teams/${props.teamId}/invitations/${revokeId}`,
          })
        }
      />
    </div>
  )
}
