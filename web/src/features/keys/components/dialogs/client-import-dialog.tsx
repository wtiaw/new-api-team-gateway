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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useStatus } from '@/hooks/use-status'
import { getUserModels } from '@/lib/api'
import { copyToClipboard } from '@/lib/copy-to-clipboard'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import { fetchTokenKey } from '../../api'
import {
  buildClientImportURL,
  gatewayImportBase,
  type ImportApp,
  type ImportClient,
} from '../../lib/client-import'
import type { ApiKey } from '../../types'

const APPS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' } as const
const MODEL_FIELDS = [
  { key: 'model', label: 'Primary Model' },
  { key: 'haikuModel', label: 'Haiku Model' },
  { key: 'sonnetModel', label: 'Sonnet Model' },
  { key: 'opusModel', label: 'Opus Model' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: ImportClient
  apiKey: ApiKey
}

export function ClientImportDialog({
  open,
  onOpenChange,
  client,
  apiKey,
}: Props) {
  const { t } = useTranslation()
  const { status } = useStatus()
  const [app, setApp] = useState<ImportApp>('codex')
  const [name, setName] = useState(apiKey.name.slice(0, 80))
  const [models, setModels] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const active = useRef(false)
  const busy = useRef(false)
  const label = client === 'cc-switch' ? 'CC Switch' : 'Magpie'
  const group = apiKey.group || apiKey.funding_policy?.resource_group || ''
  const address =
    typeof status?.server_address === 'string' && status.server_address
      ? status.server_address
      : window.location.origin
  let base = ''
  try {
    base = gatewayImportBase(address)
  } catch {
    /* Display the validation message below. */
  }

  useEffect(() => {
    active.current = open
    return () => {
      active.current = false
    }
  }, [open])

  const { data: modelsData } = useQuery({
    queryKey: ['user-models-client-import', group],
    queryFn: async () => requireServerSuccess(await getUserModels(group)),
    enabled:
      open && client === 'cc-switch' && Boolean(group) && group !== 'auto',
    staleTime: 0,
  })
  const allowed = new Set(
    (apiKey.model_limits || '').split(',').filter(Boolean)
  )
  const modelOptions = (modelsData?.data ?? [])
    .filter((model) => !apiKey.model_limits_enabled || allowed.has(model))
    .map((model) => ({ value: model, label: model }))

  const changeOpen = (next: boolean) => {
    if (!next) active.current = false
    onOpenChange(next)
  }

  const handleImport = async (copy: boolean) => {
    if (busy.current || !base || !name.trim()) return
    busy.current = true
    setPending(true)
    try {
      // Fetch only on explicit export. Never reuse a credential cached by another action.
      const response = requireServerSuccess(await fetchTokenKey(apiKey.id))
      if (!active.current) return
      const url = buildClientImportURL({
        client,
        app,
        address,
        name,
        models,
        key: response.data?.key ?? '',
      })
      if (copy) {
        const copied = await copyToClipboard(url)
        if (!active.current) return
        if (copied) toast.success(t('Copied'))
        else toast.error(t('Could not copy the import link'))
      } else {
        window.open(url, '_self')
        toast.info(t('Confirm the import in {{client}}', { client: label }))
      }
    } catch (error) {
      if (active.current) handleServerError(error, t('Client import failed'))
    } finally {
      busy.current = false
      if (active.current) setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title={t('Import to {{client}}', { client: label })}
      description={t(
        'Import this API key and gateway address into your client.'
      )}
      contentClassName='sm:max-w-md'
      contentHeight='auto'
      footer={
        <div className='flex w-full flex-wrap justify-end gap-2'>
          <Button variant='ghost' onClick={() => changeOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button
            variant='outline'
            disabled={pending || !base || !name.trim()}
            onClick={() => void handleImport(true)}
          >
            {t('Copy import link')}
          </Button>
          <Button
            disabled={pending || !base || !name.trim()}
            onClick={() => void handleImport(false)}
          >
            {pending
              ? t('Preparing import…')
              : t('Open {{client}}', { client: label })}
          </Button>
        </div>
      }
    >
      <FieldGroup>
        <div className='bg-muted/40 rounded-md border p-3 text-sm break-all'>
          <p className='font-medium'>{apiKey.name}</p>
          <p className='text-muted-foreground'>
            {base ||
              t('A valid HTTPS gateway address is required for client import')}
          </p>
          {group && (
            <p className='text-muted-foreground'>
              {t('Group')}: {group}
            </p>
          )}
        </div>
        {client === 'cc-switch' && (
          <Field>
            <FieldLabel>{t('Application')}</FieldLabel>
            <RadioGroup
              value={app}
              onValueChange={(value) => {
                setApp(value as ImportApp)
                setModels({})
              }}
              className='flex flex-wrap gap-4'
            >
              {Object.entries(APPS).map(([key, value]) => (
                <div key={key} className='flex items-center gap-2'>
                  <RadioGroupItem
                    value={key}
                    id={`import-${key}`}
                    disabled={pending}
                  />
                  <Label htmlFor={`import-${key}`}>{value}</Label>
                </div>
              ))}
            </RadioGroup>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor='client-import-name'>{t('Name')}</FieldLabel>
          <Input
            id='client-import-name'
            value={name}
            maxLength={80}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {client === 'cc-switch' &&
          MODEL_FIELDS.filter(
            (field) => app === 'claude' || field.key === 'model'
          ).map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`client-import-${field.key}`}>
                {t(field.label)}
              </FieldLabel>
              <Combobox
                id={`client-import-${field.key}`}
                aria-label={t(field.label)}
                options={modelOptions}
                value={models[field.key] || ''}
                disabled={pending}
                onValueChange={(value) =>
                  setModels((previous) => ({
                    ...previous,
                    [field.key]: value ?? '',
                  }))
                }
                placeholder={t('Select or enter model name')}
                emptyText={t('No models found')}
              />
              {field.key === 'model' && (
                <FieldDescription>
                  {t('Optional. Leave empty to use the client default model.')}
                </FieldDescription>
              )}
            </Field>
          ))}
        {client === 'magpie' && (
          <p className='text-muted-foreground text-sm'>
            {t(
              'Magpie discovers the models available to this key automatically.'
            )}
          </p>
        )}
        <p className='text-muted-foreground text-sm'>
          {t(
            'Install and open {{client}} first, then confirm the browser prompt. Import links contain your API key; keep them private.',
            { client: label }
          )}{' '}
          <a
            className='underline underline-offset-4'
            target='_blank'
            rel='noopener noreferrer'
            href={
              client === 'cc-switch'
                ? 'https://github.com/farion1231/cc-switch/releases'
                : 'https://usemagpie.ai/'
            }
          >
            {t('Download {{client}}', { client: label })}
          </a>
        </p>
      </FieldGroup>
    </Dialog>
  )
}
