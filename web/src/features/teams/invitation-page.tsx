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
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Main } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerErrorMessage } from '@/lib/server-error-message'

import { teamGet, teamWrite } from './api'

type Preview = {
  team: { name: string }
  state: 'active' | 'expired' | 'revoked' | 'accepted' | 'disabled'
  expired_at: number
  accepted_by_current_user: boolean
}
export function TeamInvitationPage(props: { token: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError('')
    setPreview(null)
    // Keep the invitation secret out of query keys and persisted caches.
    void teamGet<Preview>(
      `/api/team-invitations/${encodeURIComponent(props.token)}`
    )
      .then((data) => {
        if (!cancelled) setPreview(data)
      })
      .catch((error) => {
        if (!cancelled) setError(getServerErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [props.token, retry])
  const accept = async () => {
    setAccepting(true)
    try {
      await teamWrite(
        'post',
        `/api/team-invitations/${encodeURIComponent(props.token)}/accept`
      )
      setPreview((current) =>
        current
          ? { ...current, state: 'accepted', accepted_by_current_user: true }
          : current
      )
    } catch (error) {
      handleServerError(error)
    } finally {
      setAccepting(false)
    }
  }
  if (error) {
    return (
      <Main>
        <ErrorState
          description={error}
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Main>
    )
  }
  if (!preview) {
    return (
      <Main>
        <LoadingState />
      </Main>
    )
  }
  return (
    <Main className='items-center justify-center p-6'>
      <section className='w-full max-w-lg space-y-5 rounded-lg border p-6'>
        <h1 className='text-2xl font-semibold'>{t('Team invitation')}</h1>
        <h2 className='text-xl break-words'>{preview.team.name}</h2>
        <p>
          {t('Expires at')}:{' '}
          {formatTimestampToDate(
            preview.expired_at,
            'seconds',
            'Asia/Shanghai'
          )}{' '}
          (Asia/Shanghai)
        </p>
        <p className='text-muted-foreground'>
          {t(
            'Joining a team keeps your personal balance independent. This invitation grants ordinary membership only.'
          )}
        </p>
        {preview.state === 'active' && (
          <Button disabled={accepting} onClick={() => void accept()}>
            {t('Join team')}
          </Button>
        )}
        {preview.state === 'accepted' && (
          <>
            <p role='status'>
              {preview.accepted_by_current_user
                ? t('Team invitation accepted')
                : t('Invitation already used')}
            </p>
            <Button onClick={() => void navigate({ to: '/teams' })}>
              {t('Open teams')}
            </Button>
          </>
        )}
        {preview.state === 'expired' && (
          <p role='status'>
            {t('This invitation has expired. Ask for a new link.')}
          </p>
        )}
        {preview.state === 'revoked' && (
          <p role='status'>{t('This invitation has been revoked.')}</p>
        )}
        {preview.state === 'disabled' && (
          <p role='status'>{t('This team is disabled.')}</p>
        )}
      </section>
    </Main>
  )
}
