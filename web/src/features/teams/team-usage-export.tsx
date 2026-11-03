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
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { downloadBlob } from '@/features/usage-logs/lib/export'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

export function TeamUsageExport(props: { teamId: number; filter: string }) {
  const { t } = useTranslation()
  const download = useMutation({
    mutationFn: async () => {
      const response = await api.get<Blob>(
        `/api/teams/${props.teamId}/usage/export?search=${encodeURIComponent(props.filter)}`,
        { responseType: 'blob' }
      )
      if (response.data.type.includes('json')) {
        requireServerSuccess(JSON.parse(await response.data.text()))
        throw new Error(t('Failed to export team usage'))
      }
      downloadBlob(`team-${props.teamId}-usage.csv`, response.data)
    },
  })
  return (
    <Button
      variant='outline'
      disabled={download.isPending}
      onClick={() => download.mutate()}
    >
      {t('Export all matching records')}
    </Button>
  )
}
