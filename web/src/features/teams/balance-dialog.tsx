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
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { useTeamMutation } from './api'
import { usdToQuota } from './quota'

export function BalanceDialog(props: {
  teamId: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState('add')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  // Reuse the same operation identifier after a timeout; changing the draft creates a new operation.
  const operationId = useRef(crypto.randomUUID())
  const save = useTeamMutation(() => {
    setConfirm(false)
    props.onOpenChange(false)
  })
  let quota: number | null = null
  try {
    quota = usdToQuota(value)
  } catch {
    /* Invalid input keeps submit disabled. */
  }
  let adjustmentLabel = t('Add')
  if (mode === 'subtract') adjustmentLabel = t('Subtract')
  if (mode === 'override') adjustmentLabel = t('Set balance')
  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={t('Adjust team balance')}
      >
        <div className='space-y-4'>
          <Label htmlFor='balance-mode'>{t('Adjustment')}</Label>
          <NativeSelect
            id='balance-mode'
            value={mode}
            onChange={(event) => {
              setMode(event.target.value)
              operationId.current = crypto.randomUUID()
            }}
          >
            <NativeSelectOption value='add'>{t('Add')}</NativeSelectOption>
            <NativeSelectOption value='subtract'>
              {t('Subtract')}
            </NativeSelectOption>
            <NativeSelectOption value='override'>
              {t('Set balance')}
            </NativeSelectOption>
          </NativeSelect>
          <Label htmlFor='balance-value'>{t('Amount (USD)')}</Label>
          <Input
            id='balance-value'
            inputMode='decimal'
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              operationId.current = crypto.randomUUID()
            }}
          />
          <Label htmlFor='balance-reason'>{t('Reason')}</Label>
          <Input
            id='balance-reason'
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              operationId.current = crypto.randomUUID()
            }}
          />
          <Button
            disabled={quota === null || !reason.trim() || save.isPending}
            onClick={() => setConfirm(true)}
          >
            {t('Review adjustment')}
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('Confirm balance adjustment')}
        desc={`${adjustmentLabel}: ${value} USD. ${reason}`}
        isLoading={save.isPending}
        handleConfirm={() =>
          save.mutate({
            method: 'post',
            path: `/api/teams/${props.teamId}/quota`,
            body: {
              mode,
              value: quota,
              reason,
              operation_id: operationId.current,
            },
          })
        }
      />
    </>
  )
}
